import { signRs256Jwt } from '@hushbox/crypto';
import { mapWithConcurrency, notificationCopyForCategory } from '@hushbox/shared';
import { fromPromise } from '../../../lib/result/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { isDomainError, unavailableError } from '../../../lib/errors/index.js';
import { timeoutPolicy } from '../../../lib/resilience/index.js';
import { PUSH_FAN_OUT_CONCURRENCY } from './fan-out-concurrency.js';
import type { PolicyRunner } from '../../../lib/resilience/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushRecipient,
  PushSender,
} from '../ports/index.js';

/** The native (FCM/APNs) partition of a message — web targets go elsewhere. */
type NativeRecipient = Extract<PushRecipient, { platform: 'ios' | 'android' }>;

/** One recipient's verdict: accepted, or rejected with a dead-token reading. */
type DeliveryOutcome =
  | { readonly recipient: NativeRecipient; readonly delivered: true }
  | { readonly recipient: NativeRecipient; readonly delivered: false; readonly dead: boolean };

const FCM_SEND_URL = 'https://fcm.googleapis.com/v1/projects';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const JWT_LIFETIME_SECONDS = 3600;
/**
 * Timeout only, no retry: a push carries no idempotency key, so a blind retry
 * can deliver the same notification twice. Without a deadline a peer that
 * accepts the connection and never answers holds the invocation open.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

interface ServiceAccountConfig {
  clientEmail: string;
  privateKeyPem: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

/**
 * Module-level OAuth token cache — survives across requests inside a Workers
 * isolate, so the JWT exchange runs once per token lifetime instead of once
 * per push. Eviction is harmless (the next send re-exchanges), which keeps
 * this within the serverless no-persistent-state rule's spirit: it is a
 * recoverable optimization, never a source of truth.
 */
let tokenCache: TokenCache | null = null;

/** @internal Test-only: resets the module-level token cache between tests. */
export function _resetTokenCache(): void {
  tokenCache = null;
}

function parseServiceAccountConfig(json: string): ServiceAccountConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  if (typeof parsed['client_email'] !== 'string' || parsed['client_email'].length === 0) {
    throw new Error('Service account JSON missing required field: client_email');
  }

  if (typeof parsed['private_key'] !== 'string' || parsed['private_key'].length === 0) {
    throw new Error('Service account JSON missing required field: private_key');
  }

  return {
    clientEmail: parsed['client_email'],
    privateKeyPem: parsed['private_key'],
  };
}

/**
 * Build the Google OAuth JWT claim set and sign it with RS256. The keyed
 * asymmetric signing lives in `@hushbox/crypto` (crypto-segregation doctrine);
 * this adapter only assembles the FCM-specific claims.
 */
function createSignedJwt(privateKeyPem: string, clientEmail: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signRs256Jwt({
    privateKeyPem,
    claims: {
      iss: clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + JWT_LIFETIME_SECONDS,
    },
  });
}

/**
 * Carries a policy failure — a deadline overrun — across the throw boundary
 * this adapter uses for per-recipient isolation. The taxonomy error rides as
 * `cause`, which the send seam reads back so a timeout stays a timeout instead
 * of collapsing into a generic transport failure.
 */
class PushPolicyFailure extends Error {
  constructor(cause: DomainError) {
    super(cause.message, { cause });
  }
}

/**
 * Runs one HTTP call under the adapter's timeout policy. The deadline is the
 * only resilience applied — a rejection propagates as a throw so the caller's
 * failure accounting classifies it exactly as a transport error.
 */
async function fetchWithDeadline(
  runner: PolicyRunner,
  call: (signal: AbortSignal) => Promise<Response>
): Promise<Response> {
  const result = await runner.run(call);
  if (result.isErr()) {
    throw new PushPolicyFailure(result.error);
  }
  return result.value;
}

async function getAccessToken(
  config: ServiceAccountConfig,
  fetchImpl: typeof fetch,
  runner: PolicyRunner
): Promise<string> {
  if (tokenCache !== null && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const jwt = await createSignedJwt(config.privateKeyPem, config.clientEmail);

  const response = await fetchWithDeadline(runner, (signal) =>
    fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
      signal,
    })
  );

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${String(response.status)}`);
  }

  const data: { access_token: string; expires_in: number } = await response.json();

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };

  return data.access_token;
}

/**
 * FCM error codes that mean the token is permanently gone and must be pruned.
 * `UNREGISTERED` is the app-uninstalled/token-rotated signal; `NOT_FOUND` is
 * the HTTP-status form of the same condition.
 */
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(['UNREGISTERED', 'NOT_FOUND']);

/**
 * Collects every error code an FCM v1 error object exposes: a bare `error`
 * string (the shape a simplified mock may send), the `error.status`, and each
 * `error.details[].errorCode`.
 */
// Exported as a test seam: the `error === null` guard is reachable only when a
// failed FCM body parses to JSON `null`, which the HTTP mock cannot force
// through `readErrorBody` reliably — so it is unit-tested directly.
export function collectFcmErrorCodes(error: unknown): string[] {
  if (typeof error === 'string') {
    return [error];
  }
  if (typeof error !== 'object' || error === null) {
    return [];
  }
  const codes: string[] = [];
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'string') {
    codes.push(status);
  }
  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const errorCode = (detail as { errorCode?: unknown }).errorCode;
      if (typeof errorCode === 'string') {
        codes.push(errorCode);
      }
    }
  }
  return codes;
}

/**
 * Reads the dead-token signal from an FCM v1 per-message error body. A body we
 * cannot interpret yields no codes, so an unparseable failure never prunes a
 * token — pruning is only ever driven by an explicit dead-token signal.
 */
function fcmBodyIsDeadToken(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const error = (body as { error?: unknown }).error;
  return collectFcmErrorCodes(error).some((code) => DEAD_TOKEN_CODES.has(code));
}

/**
 * Parses a failed FCM response body without letting a non-JSON body throw —
 * an error response that is not JSON simply cannot signal a dead token.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
    // A non-JSON error body carries no dead-token signal, so the safe read is
    // "unknown ⇒ never prune"; this is a deliberate no-op, not a hidden error.
    // eslint-disable-next-line catch-swallow/no-silent-catch -- unparseable body yields no dead-token verdict by design
  } catch {
    return undefined;
  }
}

interface FcmPushSenderConfig {
  readonly projectId: string;
  readonly serviceAccountJson: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Asks FCM to validate the request without delivering it (`validate_only`,
   * a top-level sibling of `message` in the v1 send body). Exists so a CI test
   * can exercise the real authenticated send path against Google without
   * pushing to a device; production never sets it, and when unset the key is
   * absent from the body rather than sent as `false`.
   */
  readonly validateOnly?: boolean;
  /** Per-call network deadline; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The real FCM adapter (HTTP v1 API). Construction fails fast on a malformed
 * service account; delivery counts per-token failures instead of failing the
 * whole send. Error messages never carry device tokens — tokens are
 * credentials and stay out of every log and error channel.
 *
 * Service evidence is deliberately NOT recorded here: an evidence row may only
 * follow a real network call to FCM, which this adapter cannot distinguish from
 * a mocked `fetchImpl`. The row is written by the CI-gated live test that makes
 * that real call.
 */
export function createFcmPushSender(config: FcmPushSenderConfig): PushSender {
  const account = parseServiceAccountConfig(config.serviceAccountJson);
  const fetchImpl = config.fetchImpl ?? fetch;
  const runner = timeoutPolicy({ timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  async function deliver(message: PushMessage): Promise<PushDelivery> {
    const accessToken = await getAccessToken(account, fetchImpl, runner);
    const url = `${FCM_SEND_URL}/${config.projectId}/messages:send`;

    const native = message.recipients.filter(
      (recipient): recipient is NativeRecipient => recipient.platform !== 'web'
    );
    const collapse = message.collapseKey;
    // The Android shade entry is addressed by the raw conversationId, because
    // the client clears a read conversation by reading a delivered
    // notification's tag. That exposes nothing the alias protects: the same
    // message's data payload already carries the id, so FCM sees it either
    // way. The alias stays on the transport collapse fields, where the Web
    // Push `Topic` header — whose payload is encrypted — would otherwise leak.
    const shadeTag = message.payload.conversationId;
    // The words are looked up from the category, never taken from the caller —
    // the same table and the same lookup the service worker performs for a web
    // notification, so the two surfaces cannot describe an event differently.
    const copy = notificationCopyForCategory(message.payload.category);
    // Projected field by field rather than forwarded wholesale: a structurally
    // typed object can carry properties the type never declared, and this is
    // the seam where such a property would reach Google.
    const data = {
      category: message.payload.category,
      conversationId: message.payload.conversationId,
    };
    const sendOne = async (recipient: NativeRecipient): Promise<DeliveryOutcome> => {
      const body = {
        message: {
          token: recipient.token,
          notification: { title: copy.title, body: copy.body },
          data,
          ...(collapse === undefined
            ? {}
            : {
                android: {
                  collapse_key: collapse,
                  notification: { tag: shadeTag },
                },
                apns: { headers: { 'apns-collapse-id': collapse } },
              }),
        },
        ...(config.validateOnly === true ? { validate_only: true } : {}),
      };

      const response = await fetchWithDeadline(runner, (signal) =>
        fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        })
      );

      if (response.ok) {
        return { recipient, delivered: true };
      }
      const dead = fcmBodyIsDeadToken(await readErrorBody(response));
      return { recipient, delivered: false, dead };
    };

    const results = await mapWithConcurrency(native, PUSH_FAN_OUT_CONCURRENCY, (recipient) =>
      // Settled per recipient: one transport throw is that recipient's
      // failure, never the fan-out's.
      sendOne(recipient).then(
        (value): PromiseSettledResult<DeliveryOutcome> => ({ status: 'fulfilled', value }),
        (error: unknown): PromiseSettledResult<DeliveryOutcome> => ({
          status: 'rejected',
          reason: error,
        })
      )
    );

    let successCount = 0;
    let failureCount = 0;
    const deliveredTokens: PushDeviceRef[] = [];
    const deadTokens: PushDeviceRef[] = [];
    for (const result of results) {
      // A rejected settlement is a network/transport throw, not a token verdict.
      if (result.status === 'rejected') {
        failureCount++;
        continue;
      }
      if (result.value.delivered) {
        successCount++;
        deliveredTokens.push({
          userId: result.value.recipient.userId,
          token: result.value.recipient.token,
        });
        continue;
      }
      failureCount++;
      if (result.value.dead) {
        deadTokens.push({
          userId: result.value.recipient.userId,
          token: result.value.recipient.token,
        });
      }
    }

    return { successCount, failureCount, deliveredTokens, deadTokens };
  }

  return {
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      if (message.recipients.length === 0) {
        return okAsync({
          successCount: 0,
          failureCount: 0,
          deliveredTokens: [],
          deadTokens: [],
        });
      }
      return fromPromise(deliver(message), (cause) =>
        cause instanceof PushPolicyFailure && isDomainError(cause.cause)
          ? cause.cause
          : unavailableError('push delivery failed', cause)
      );
    },
  };
}
