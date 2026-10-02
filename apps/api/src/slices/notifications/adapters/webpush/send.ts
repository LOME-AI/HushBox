import { fromBase64 } from '@hushbox/shared';
import { errAsync, fromPromise } from '../../../../lib/result/index.js';
import { unavailableError, validationError } from '../../../../lib/errors/index.js';
import { timeoutPolicy } from '../../../../lib/resilience/index.js';
import { encryptWebPushPayload, generateEphemeralKey, MAX_PLAINTEXT_BYTES } from './encrypt.js';
import { createVapidAuthorization } from './vapid.js';
import type { EphemeralKeyMaterial } from './encrypt.js';
import type { VapidKeys } from './vapid.js';
import type { PolicyRunner } from '../../../../lib/resilience/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * The in-house Web Push transport (RFC 8030 request framing over the RFC 8291 /
 * RFC 8188 encrypted body and the RFC 8292 VAPID identification header). This is
 * the single-recipient send primitive; the composite push adapter partitions
 * recipients and prunes the `dead` ones.
 *
 * Best-effort by doctrine: an HTTP response is always classified, never thrown.
 * Only a transport-level exception surfaces as an `unavailable` error.
 */

/** RFC 8030 §5.3 urgency levels. */
const VALID_URGENCIES: ReadonlySet<string> = new Set(['very-low', 'low', 'normal', 'high']);

/** RFC 8030 §5.4 Topic: ≤32 characters of the URL/base64url-safe alphabet. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// 401/403 are terminal like 404/410: RFC 8292 §4.2 binds a subscription to one VAPID key.
const DEAD_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);

/**
 * Timeout only, no retry: a push carries no idempotency key, so a blind retry
 * can deliver the same notification twice. Endpoint URLs are supplied by the
 * subscribing browser, so a push service that accepts the connection and never
 * answers is registrable — without a deadline it holds the invocation open.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Shared across sends so the policy is built once per isolate. */
const defaultRunner = timeoutPolicy({ timeoutMs: DEFAULT_TIMEOUT_MS });

/** The shared policy unless a caller overrode the deadline. */
function runnerFor(timeoutMs: number | undefined): PolicyRunner {
  return timeoutMs === undefined ? defaultRunner : timeoutPolicy({ timeoutMs });
}

export interface WebPushSubscription {
  readonly endpoint: string;
  /** Subscription `p256dh` key, base64url (65-byte uncompressed P-256 point). */
  readonly p256dh: string;
  /** Subscription `auth` secret, base64url (16 bytes). */
  readonly auth: string;
}

interface WebPushSendOptions {
  /** RFC 8030 TTL header — seconds the push service retains the message. */
  readonly ttl: number;
  /** Optional collapse alias (never a raw conversationId — see generic payload law). */
  readonly topic?: string;
  /** Optional RFC 8030 urgency. */
  readonly urgency?: string;
}

/**
 * `delivered` — the push service accepted it (2xx).
 * `dead` — the subscription is gone or rejects our key (401/403/404/410); the caller prunes it.
 * `failed` — a transient rejection (any other status); best-effort, no retry.
 */
export type WebPushOutcome = 'delivered' | 'dead' | 'failed';

export interface WebPushSendResult {
  readonly outcome: WebPushOutcome;
  readonly statusCode: number;
}

export interface WebPushSendDeps {
  readonly vapid: VapidKeys;
  readonly fetchImpl?: typeof fetch;
  /** Ephemeral key source (fresh random in production, injected in tests). */
  readonly generateEphemeral?: () => Promise<EphemeralKeyMaterial>;
  /** Salt source (fresh random in production, injected in tests). */
  readonly generateSalt?: () => Uint8Array;
  /** Clock in epoch milliseconds (injected in tests). */
  readonly now?: () => number;
  /** Per-send network deadline; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function classify(status: number): WebPushOutcome {
  if (status >= 200 && status < 300) return 'delivered';
  if (DEAD_STATUSES.has(status)) return 'dead';
  return 'failed';
}

/**
 * Encrypts and sends one Web Push message. Preconditions (topic/ttl/urgency
 * shape, payload size) fail fast as `validation` errors before any crypto or
 * network work.
 */
export function sendWebPush(
  subscription: WebPushSubscription,
  payload: Uint8Array,
  options: WebPushSendOptions,
  deps: WebPushSendDeps
): ResultAsync<WebPushSendResult, DomainError> {
  if (options.topic !== undefined && !TOPIC_PATTERN.test(options.topic)) {
    return errAsync(validationError('web push Topic must be 1-32 chars of [A-Za-z0-9_-]'));
  }
  if (!Number.isInteger(options.ttl) || options.ttl < 0) {
    return errAsync(validationError('web push TTL must be a non-negative integer'));
  }
  if (options.urgency !== undefined && !VALID_URGENCIES.has(options.urgency)) {
    return errAsync(validationError('web push Urgency is not a recognized level'));
  }
  if (payload.length > MAX_PLAINTEXT_BYTES) {
    return errAsync(validationError('web push payload exceeds the RFC 8291 plaintext ceiling'));
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = (deps.now ?? Date.now)();
  const runner = runnerFor(deps.timeoutMs);

  const prepare = async (): Promise<{
    readonly headers: Record<string, string>;
    readonly body: Uint8Array<ArrayBuffer>;
  }> => {
    const ephemeral = await (deps.generateEphemeral ?? generateEphemeralKey)();
    const salt = deps.generateSalt === undefined ? randomSalt() : deps.generateSalt();

    const body = await encryptWebPushPayload({
      plaintext: payload,
      clientPublicKey: fromBase64(subscription.p256dh),
      authSecret: fromBase64(subscription.auth),
      salt,
      ephemeral,
    });

    const authorization = await createVapidAuthorization({
      endpoint: subscription.endpoint,
      keys: deps.vapid,
      nowMs,
    });

    return {
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(options.ttl),
        Authorization: authorization,
        ...(options.topic === undefined ? {} : { Topic: options.topic }),
        ...(options.urgency === undefined ? {} : { Urgency: options.urgency }),
      },
      body,
    };
  };

  // The deadline covers the network call only: encryption and VAPID signing are
  // local work that cannot hang on a remote peer.
  return fromPromise(prepare(), (cause) => unavailableError('web push send failed', cause))
    .andThen(({ headers, body }) =>
      runner.run((signal) =>
        fetchImpl(subscription.endpoint, { method: 'POST', headers, body, signal })
      )
    )
    .map((response) => ({ outcome: classify(response.status), statusCode: response.status }));
}
