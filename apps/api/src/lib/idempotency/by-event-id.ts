import { brandIdempotent } from './brands.js';
import type { ResultAsync } from '../result/index.js';
import type { Idempotent } from './brands.js';

export interface ByEventIdParams<T, E> {
  /**
   * Decides whether this call is the one that runs `execute`. The requirement:
   * across any set of calls that must run `execute` at most once between them,
   * `claim` resolves true for at most one of them — atomically, so two racing
   * calls cannot both win. What that set is and what it is keyed on is the
   * caller's, read at the call seam and never assumed here. A Postgres write
   * for money events, always; Redis `SET NX` + TTL is admissible only where
   * losing the dedup record is tolerable (non-money).
   */
  readonly claim: () => ResultAsync<boolean, E>;
  /** Runs only for the call whose claim resolved true. */
  readonly execute: () => ResultAsync<T, E>;
  /** The outcome when the claim resolves false (e.g. re-read the prior result). */
  readonly onDuplicate: () => ResultAsync<T, E>;
}

/**
 * Runs an effect behind the caller's atomic claim, so duplicate and racing
 * calls execute it exactly once. Nothing here is keyed on an event id: both
 * the claim and what it is keyed on are the caller's, stated at
 * {@link ByEventIdParams.claim}. The job registry's `byEventId` idempotency
 * class is a different thing — it names a handler's own dedup property, not a
 * call to this wrapper.
 */
export function byEventId<T, E>(params: ByEventIdParams<T, E>): ResultAsync<Idempotent<T>, E> {
  return params
    .claim()
    .andThen((claimed) => (claimed ? params.execute() : params.onDuplicate()))
    .map((value) => brandIdempotent(value));
}
