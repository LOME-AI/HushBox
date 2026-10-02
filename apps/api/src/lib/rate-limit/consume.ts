import { errors } from '@upstash/redis';
import { unavailableError, validationError } from '../errors/index.js';
import { Result, err, errAsync, ok, okAsync } from '../result/index.js';
import { rateLimitBound } from './bound.js';
import { hmacRateLimitId } from './key-secret.js';
import { CONSUME_SCRIPT } from './script.js';
import type { Redis } from '@upstash/redis';
import type { DomainError, DomainErrorOf } from '../errors/index.js';
import type { PolicyRunner } from '../resilience/index.js';
import type { ResultAsync } from '../result/index.js';
import type { RateLimitDefinition, ReservationLimit } from './definition.js';

/**
 * What one check answers. `count` rides both arms because a caller that
 * notifies on the crossing attempt needs it (`count === maxAttempts + 1` is
 * the one attempt that crossed); `retryAfterSeconds` rides only the refused
 * arm because an admitted attempt has nothing to wait for.
 */
export type RateLimitDecision =
  | { readonly allowed: true; readonly count: number }
  | { readonly allowed: false; readonly count: number; readonly retryAfterSeconds: number };

/** One layer of a layered check: a registry entry and the identity it counts. */
export interface RateLimitLayer {
  readonly definition: RateLimitDefinition;
  readonly id: string;
}

/**
 * What a layered check answers. The refused arm names the layer that refused
 * by its position in the call, and its `count` and `retryAfterSeconds` are
 * that layer's — a sibling layer's window says nothing about when this caller
 * may retry.
 */
export type LayeredRateLimitDecision =
  | { readonly allowed: true; readonly count: number }
  | {
      readonly allowed: false;
      readonly count: number;
      readonly retryAfterSeconds: number;
      readonly layer: number;
    };

const REPLY = /^(allowed|refused):(\d+):(\d+):(\d+)$/;

/**
 * Longest identifier a counter check accepts, so a caller cannot hand the
 * encoder an arbitrarily large input.
 *
 * No entry can reach it today, and that is the point: the edge-mounted entries
 * key on a SHA-256 hex digest (64), and the identity entries key on values Zod
 * bounds at 254 at the HTTP boundary — two characters of headroom. So this
 * bound never fires for anything currently registered. It is a defence against
 * a FUTURE entry that keys on an unvalidated field, which is the only way an
 * unbounded identifier reaches the encoder. Do not read a passing suite as evidence
 * the bound is unnecessary.
 */
export const MAX_IDENTIFIER_LENGTH = 256;

/**
 * The bound on every round trip this module makes, from {@link rateLimitBound}.
 * The Upstash client retries with backoff and carries no per-attempt timeout,
 * so without it an unreachable endpoint stalls the request for seconds before
 * the fail-closed and fail-open paths ever get their answer. What makes it bind
 * is that the policy settles at the deadline whether or not the task does:
 * neither `Script.exec` nor `del` accepts an abort signal, so the HTTP request
 * it started runs on regardless.
 *
 * An abandoned check can therefore still have been counted. Against a Redis
 * that is slow rather than gone, the script arrives and spends the attempt
 * while the caller is told only that the counter was unreachable — so a
 * caller's view of a counter can lag the counter, and a slow endpoint advances
 * windows no caller ever learns the outcome of.
 */
function withinBound(): PolicyRunner {
  return rateLimitBound().runner;
}

/**
 * Which failure a check that answered no decision actually met. Diagnosis
 * only: every arm still mints one `unavailable` error, so a caller decides on
 * whether the counter answered and never on this — the vocabulary exists so a
 * reporter can say WHICH failure an incident was, which a bare `unavailable`
 * cannot and which no artifact of a failed run has ever recorded.
 *
 * `timeout` — the round trip outran {@link withinBound}.
 * `transport` — the request to the store threw, after the client's own retries.
 * `store-error` — the store answered and its answer was an error: an HTTP
 *   failure from the endpoint, or a script error reply.
 * `unreadable` — the store answered something {@link REPLY} cannot read.
 *
 * The four are codes and nothing else travels with them, which is the point
 * rather than an economy. The `UpstashError` behind an endpoint's HTTP failure
 * carries the request body in its own message, and a counter check's request
 * body is the script and its KEYS — so a reporter that lifted the cause chain
 * into a retained channel would be publishing counter keys. These name which
 * failure it was and nothing about what was being counted.
 */
const RATE_LIMIT_FAILURES = ['timeout', 'transport', 'store-error', 'unreadable'] as const;

export type RateLimitFailure = (typeof RATE_LIMIT_FAILURES)[number];

/** The `unavailable` error this module mints, carrying the arm that minted it. */
interface RateLimitUnavailableError extends DomainErrorOf<'unavailable'> {
  readonly rateLimitFailure: RateLimitFailure;
}

/**
 * The arm behind a bounded round trip's failure. The policy answers `timeout`
 * for its own deadline and `unavailable` for whatever the task threw, so the
 * arm is the policy's code first and the thrown value's identity second.
 *
 * `UpstashJSONParseError` extends `UpstashError`, so one check covers both the
 * endpoint's HTTP failures and a body this client could not parse. `transport`
 * is the remainder, and it is a remainder rather than a fifth test: what falls
 * into it is everything thrown before the store answered, plus the one shape
 * the client throws for an answer carrying no result at all.
 */
export function failureOfBoundedCall(error: DomainError): RateLimitFailure {
  if (error.code === 'timeout') return 'timeout';
  return error.cause instanceof errors.UpstashError ? 'store-error' : 'transport';
}

function unavailableFrom(
  message: string,
  failure: RateLimitFailure,
  cause?: unknown
): RateLimitUnavailableError {
  return { ...unavailableError(message, cause), rateLimitFailure: failure };
}

/**
 * The arm an error carries, or `undefined` for one this module did not mint.
 * A reader rather than a narrowed error type: the counting primitive answers
 * the base `DomainError` its callers already thread through their own domain
 * results, and the pipeline seam that reports the failure types it that way
 * too, so a narrowed type would be erased before it ever reached a reporter.
 */
export function rateLimitFailureOf(error: DomainError): RateLimitFailure | undefined {
  if (!('rateLimitFailure' in error)) return undefined;
  const carried: unknown = error.rateLimitFailure;
  return RATE_LIMIT_FAILURES.find((candidate) => candidate === carried);
}

/**
 * The counter key `consume` and `clear` actually operate on: the definition's
 * key over the identifier's keyed digest ({@link hmacRateLimitId}), never the
 * identifier itself, so no email, login identifier or token is legible in the
 * store's key names. The digest is fixed-width hex, which also keeps an
 * identifier from impersonating a key segment boundary — an IPv6 address
 * carries the delimiter, and an entry keyed `<prefix>:<id>` would otherwise
 * collide with a sibling keyed `<prefix>:a:<id>`.
 *
 * Exported because a caller that needs to name a key — a test seeding a window
 * at its cap, or a reset clearing one — would otherwise re-derive the digest,
 * and a second copy of an encoder is the duplication this module exists to
 * remove. It answers a key; it never counts.
 */
export function rateLimitKey(
  definition: RateLimitDefinition,
  id: string
): Result<string, DomainError> {
  if (id.length > MAX_IDENTIFIER_LENGTH) {
    return err(validationError('rate limit identifier exceeds the maximum length'));
  }
  return ok(definition.buildKey(hmacRateLimitId(id)));
}

/**
 * Spends one attempt against every layer's counter and decides in the same
 * Redis round trip. The decision is all-or-nothing: when no layer refuses,
 * every layer is counted; when any refuses, ONLY the refusing layers are —
 * otherwise an attacker sharing one layer's identity (an IP) drains a
 * legitimate caller's personal budget with requests that were never admitted.
 *
 * The refusing layers still advance past their caps, which is the constraint
 * that rules out the obvious check-then-skip: a caller notifying on the
 * crossing attempt (the login lockout email) reads `maxAttempts + 1`, and a
 * counter parked at its cap fires that notification either never or on every
 * subsequent attempt.
 *
 * Fails closed: an unreachable Redis, a check that outruns
 * {@link withinBound}, a script error, or a reply this cannot
 * read all surface as one `unavailable` error, deliberately indistinguishable
 * — a caller decides on whether the counter answered, never on how it failed
 * to. There is no decision value a caller could mistake for admission. The
 * error does carry which of them it was, for a reporter to read through
 * {@link rateLimitFailureOf}; that is diagnosis and nothing branches on it, so
 * the four stay one refusal at every seam a caller can see. An
 * empty layer list throws instead of answering: a check that counts nothing
 * admits everything, so an empty list is a composition defect, like a
 * user-keyed limiter on a public route. A mount whose layers all skip a caller
 * never reaches here — the middleware resolves that to an explicit uncounted
 * admission before it calls.
 */
export function consumeLayers(
  redis: Redis,
  layers: readonly RateLimitLayer[]
): ResultAsync<LayeredRateLimitDecision, DomainError> {
  if (layers.length === 0) {
    throw new Error('consumeLayers requires at least one layer — a check over none admits all');
  }
  return Result.combine(layers.map((entry) => rateLimitKey(entry.definition, entry.id)))
    .asyncAndThen((keys) =>
      withinBound()
        .run(() =>
          redis.createScript<string>(CONSUME_SCRIPT).exec(
            keys,
            layers.flatMap((entry) => [
              String(entry.definition.maxAttempts),
              String(entry.definition.windowSeconds),
            ])
          )
        )
        .mapErr((cause) =>
          unavailableFrom('rate limit consume failed', failureOfBoundedCall(cause), cause)
        )
    )
    .andThen((reply) => {
      const parsed = REPLY.exec(reply);
      if (parsed === null) {
        return errAsync<LayeredRateLimitDecision, DomainError>(
          unavailableFrom('rate limit script returned an unknown outcome', 'unreadable')
        );
      }
      const count = Number(parsed[3]);
      return okAsync<LayeredRateLimitDecision, DomainError>(
        parsed[1] === 'allowed'
          ? { allowed: true, count }
          : {
              allowed: false,
              count,
              retryAfterSeconds: Number(parsed[4]),
              layer: Number(parsed[2]) - 1,
            }
      );
    });
}

/**
 * Spends one attempt against `definition`'s counter for `id` and decides in
 * the same Redis round trip. Identical for both limiter classes — reservation
 * and throttle count the same way and differ only in whether the counter is
 * ever cleared.
 *
 * The degenerate layered check, and deliberately not a second path through the
 * script: one layer can never refuse a sibling, so all-or-nothing is vacuous
 * and the decision is the layered one with the layer index dropped — there is
 * only one, and naming it would tell the caller nothing.
 */
export function consume(
  redis: Redis,
  definition: RateLimitDefinition,
  id: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consumeLayers(redis, [{ definition, id }]).map(
    (decision): RateLimitDecision =>
      decision.allowed
        ? { allowed: true, count: decision.count }
        : {
            allowed: false,
            count: decision.count,
            retryAfterSeconds: decision.retryAfterSeconds,
          }
  );
}

/**
 * Drops the counter, so the next attempt starts a fresh window. Reservation
 * entries only: this is the verified-success clear that separates a
 * secret-guessing gate from an abuse throttle, and a throttle reaching it
 * would hand an attacker a reset. The parameter type is the enforcement —
 * there is no runtime check to forget.
 *
 * Best-effort by construction, and the error type is the enforcement: every
 * call site clears after the operation it guards has already succeeded, so a
 * failure the caller could act on would deny a password it has just verified.
 * Absorbing loses nothing, because failing to clear fails SAFE: the counter
 * survives, so a lockout stays in force rather than being wrongly lifted, and
 * an identifier {@link rateLimitKey} refuses is one {@link consume} refuses
 * too, so no counter under it exists to clear.
 *
 * Bounded by {@link withinBound} for the same reason the check is: this runs on
 * the success path, so an unreachable endpoint would stall an operation that
 * has already succeeded — the bound is what makes absorbing the failure cheap
 * rather than a wait for the client's whole retry schedule.
 *
 * The absorption is over this function's error channel, and a throw is not in
 * it. {@link withinBound} throws when no composition root has configured the
 * bound, and neverthrow runs `asyncAndThen`'s function with no try/catch, so
 * that escapes synchronously past the `orElse` and reaches the caller as a
 * defect. Deliberate — an unconfigured process is a composition defect, not a
 * runtime condition — but it is the one way an entry point that reaches a
 * clear without configuring the bound can still fail an operation that has
 * already succeeded.
 */
export function clear(
  redis: Redis,
  definition: ReservationLimit,
  id: string
): ResultAsync<void, never> {
  return rateLimitKey(definition, id)
    .asyncAndThen((key) => withinBound().run(() => redis.del(key)))
    .map((): void => undefined)
    .orElse((): ResultAsync<void, never> => okAsync());
}
