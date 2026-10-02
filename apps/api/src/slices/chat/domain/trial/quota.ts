import { z } from 'zod';
import { TRIAL_MESSAGE_LIMIT, utcDayKey } from '@hushbox/shared';
import { Result } from '../../../../lib/result/index.js';
import { consumeLayers, rateLimitKey } from '../../../../lib/rate-limit/index.js';
import { redisMGet } from '../../../../lib/redis/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ThrottleLimit } from '../../../../lib/rate-limit/index.js';
import type { Variables } from '../../../../lib/context/index.js';

/**
 * The trial 5/day quota — the dual-identity anti-evasion gate that lives in the
 * trial ROUTE (it holds both the client's `x-trial-token` and the request IP,
 * which the admission hook cannot see). It spends one attempt against a
 * per-session and a per-IP counter and admits only when both hold: a rotated
 * token starts a fresh session count, but the IP count still catches the
 * evasion.
 *
 * Both counters are abuse throttles, not secret-guessing surfaces: they guard
 * an entitlement rather than a guessable credential, nothing clears them on a
 * successful send, and a refused send reserves nothing refundable.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/**
 * The counter's lifetime. The UTC day inside the key is what bounds the quota
 * to a day, so this window only has to outlive the day it counts — a key minted
 * just before midnight is never addressed again and lingers as garbage for
 * roughly a day (accepted GC slack, no correctness effect).
 */
const TRIAL_QUOTA_WINDOW_SECONDS = 24 * 60 * 60;

/** Per trial-session id (the `x-trial-token`, or a freshly minted uuid). */
export const TRIAL_QUOTA_SESSION_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: TRIAL_MESSAGE_LIMIT,
  windowSeconds: TRIAL_QUOTA_WINDOW_SECONDS,
  buildKey: (dayScopedSessionId: string) =>
    `ratelimit:chat:trial-quota:session:${dayScopedSessionId}`,
} as const satisfies ThrottleLimit;

/** Per client-IP (SHA-256 hash) — the identity a rotated token cannot dodge. */
export const TRIAL_QUOTA_IP_RATE_LIMIT = {
  kind: 'throttle',
  maxAttempts: TRIAL_MESSAGE_LIMIT,
  windowSeconds: TRIAL_QUOTA_WINDOW_SECONDS,
  buildKey: (dayScopedIpHash: string) => `ratelimit:chat:trial-quota:ip:${dayScopedIpHash}`,
} as const satisfies ThrottleLimit;

/** The identity a counter is keyed by: the identity itself, scoped to its UTC day. */
function dayScoped(now: Date, id: string): string {
  return `${utcDayKey(now)}:${id}`;
}

/**
 * The IP counter's key on `now`'s day — the single derivation of it.
 *
 * Exported for the callers that must name the key rather than advance it: the
 * integration suite's cleanup of its sentinel IP identity (the one trial
 * identity that is not unique per test), and the dev trial-usage reset, which
 * frees the calling identity's counter without touching any other caller's.
 * `clear` is unreachable from a throttle by type, and deliberately so, which
 * leaves naming the key as the only way.
 *
 * It exists because the alternative already failed: that cleanup used to write
 * the key template out itself, and when the counter moved onto the rate-limit
 * primitive the cleanup silently went on deleting a key nothing writes.
 */
export function trialQuotaIpKey(now: Date, ipHash: string): Result<string, DomainError> {
  return rateLimitKey(TRIAL_QUOTA_IP_RATE_LIMIT, dayScoped(now, ipHash));
}

/**
 * A counter's stored value. Coerced because the value is written by `INCR`
 * inside the Lua script and read back over the Upstash HTTP client, which is
 * free to render an integer as a JSON string; the bounds are what stay strict.
 */
const SPENT_ATTEMPTS = z.coerce.number().int().nonnegative();

/**
 * How many trial messages the caller may still send today, read WITHOUT
 * spending one — the same verdict `consumeTrialQuota` enforces, expressed as a
 * number the composer can display, so what the user sees and what the send gate
 * applies can never be two different rules.
 *
 * It reads the same two counters against the stricter identity: the allowance
 * left is the limit minus whichever identity has spent more, because a send
 * needs BOTH to admit. An absent counter and a counter at zero are the same
 * state — trial sessions are never persisted, so there is nothing to exist and
 * no read here can distinguish a token that was never seen from one that has
 * simply not sent.
 *
 * Both keys are fetched in ONE round trip: two sequential GETs would double the
 * load on the single Redis HTTP proxy for a decision that needs both values.
 * Redis down fails closed (typed `unavailable`) — the count is refused, never
 * guessed.
 */
export function readTrialQuotaRemaining(
  redis: RedisClient,
  args: ConsumeTrialQuotaArgs
): ResultAsync<number, DomainError> {
  return Result.combine([
    rateLimitKey(TRIAL_QUOTA_SESSION_RATE_LIMIT, dayScoped(args.now, args.sessionId)),
    rateLimitKey(TRIAL_QUOTA_IP_RATE_LIMIT, dayScoped(args.now, args.ipHash)),
  ])
    .asyncAndThen(([sessionKey, ipKey]) =>
      // Entries built from the rate-limit registry's own key derivation rather
      // than `redisMGetEntry`, whose definitions are the Redis key registry —
      // these counters belong to the other registry, and re-deriving their keys
      // here would be the second copy `rateLimitKey` exists to prevent.
      redisMGet(redis, [
        { key: sessionKey, schema: SPENT_ATTEMPTS },
        { key: ipKey, schema: SPENT_ATTEMPTS },
      ])
    )
    .map(([session, ip]) => Math.max(0, TRIAL_MESSAGE_LIMIT - Math.max(session ?? 0, ip ?? 0)));
}

interface TrialQuotaResult {
  readonly allowed: boolean;
  readonly count: number;
}

interface ConsumeTrialQuotaArgs {
  readonly sessionId: string;
  readonly ipHash: string;
  /** The instant whose UTC day the two counters are scoped to. */
  readonly now: Date;
}

/**
 * Consume one trial message slot across BOTH identities, as ONE layered check:
 * a send is admitted only when both identities admit it, and a refused send
 * spends a slot on neither identity that would have admitted it. Two separate
 * checks cannot express that — the first counter is already spent by the time
 * the second refuses — which is how a rotated token used to burn a session
 * slot behind an exhausted IP, and how one address used to drain every token
 * that ever appeared behind it.
 *
 * The reported `count` is the same verdict read as a number: at or under the
 * limit is exactly the case where neither identity refused. Redis down fails
 * closed (typed `unavailable`) — the trial send is refused, never silently
 * admitted.
 */
export function consumeTrialQuota(
  redis: RedisClient,
  args: ConsumeTrialQuotaArgs
): ResultAsync<TrialQuotaResult, DomainError> {
  return consumeLayers(redis, [
    {
      definition: TRIAL_QUOTA_SESSION_RATE_LIMIT,
      id: dayScoped(args.now, args.sessionId),
    },
    { definition: TRIAL_QUOTA_IP_RATE_LIMIT, id: dayScoped(args.now, args.ipHash) },
  ]).map((decision) => ({ allowed: decision.allowed, count: decision.count }));
}
