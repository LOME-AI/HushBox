/**
 * The names the idempotency seam is spelled with, resolved once because two
 * rules judge the same registrations from opposite sides:
 * `idempotency-exemption-wrappers` proves a DECLARED-EXEMPT route carries a
 * wrapper, `mutating-routes-prove-idempotency` proves a NON-exempt mutating
 * route reaches the mechanism.
 *
 * Drifting {@link EXEMPTION_MARKER} is the sharp one: the marker SUBTRACTS
 * routes from one rule's checked set and selects them into the other's, so a
 * marker known to one spelling and not the other leaves an exemption excused by
 * one rule and unpoliced by the other — a silent hole in both directions at
 * once. {@link IDEMPOTENT_WRAPPERS} drifts more quietly: renaming a wrapper in
 * one list leaves the other proving nothing while still passing.
 */

/** The inline marker that declares a route exempt from Idempotency-Key. */
export const EXEMPTION_MARKER = 'idempotencyExempt';

/** The namespace object the HTTP wrappers hang off (`idempotent.byKey`). */
export const IDEMPOTENT = 'idempotent';

/**
 * The five wrappers, the only entry to `runMutation` — which accepts nothing
 * else. A rule naming a subset selects OUT of this list rather than re-typing
 * one, so a name that is not in this list does not type-check where a rule
 * declares a subset.
 */
export const IDEMPOTENT_WRAPPERS = [
  'byKey',
  'byUpsert',
  'byTransition',
  'byEventId',
  'byExternalPreClaim',
] as const;

export type IdempotentWrapper = (typeof IDEMPOTENT_WRAPPERS)[number];
