/**
 * A rate-limit registry entry: one counter key, its cap, and its window.
 *
 * There is one `windowSeconds` and no separate key TTL, because the two are
 * the same fact — a fixed window's counter must live exactly as long as the
 * window it counts. Carrying both would be a sync contract between two
 * numbers that can only ever be equal.
 *
 * `kind` is the ONLY difference between the two limiter classes, and it is a
 * lifecycle difference, not a counting one: `consume` is identical for both.
 *
 * It gates whether `clear` is REACHABLE, not whether it is called. A
 * reservation is a secret-guessing surface (login, TOTP, recovery) whose
 * counter MAY be cleared on a verified success; a throttle (registration,
 * resend, volume caps) never clears and reserves nothing refundable.
 *
 * The distinction matters when classifying an entry, because "clears on
 * success" does not separate the classes on its own: both recovery lockouts
 * are reservations that never clear, because the server has no verified
 * success to clear on — every recovery response is identical by design
 * (enumeration safety) and the recovery phrase never leaves the client. They
 * are reservations because the surface they guard is offline-attackable
 * secret guessing, not because anything resets them. Classify on what the
 * surface IS; a reservation with no verifiable success simply never clears.
 *
 * Declaring `kind` in the type is what makes `clear` unreachable from a
 * throttle at compile time.
 *
 * Entries are written as object literals validated against the class they
 * belong to, which keeps `kind` at its literal type:
 *
 * ```ts
 * export const loginLockout = {
 *   kind: 'reservation',
 *   maxAttempts: 5,
 *   windowSeconds: 900,
 *   buildKey: (userId: string) => `identity:login:lockout:${userId}`,
 * } as const satisfies ReservationLimit;
 * ```
 */
type RateLimitKind = 'reservation' | 'throttle';

export interface RateLimitDefinition<TKind extends RateLimitKind = RateLimitKind> {
  readonly kind: TKind;
  /** Attempts admitted per window. The `maxAttempts + 1`-th is refused. */
  readonly maxAttempts: number;
  /** Window length, and the counter key's lifetime, in whole seconds. */
  readonly windowSeconds: number;
  readonly buildKey: (id: string) => string;
}

/** A secret-guessing surface: clears its counter on verified success. */
export type ReservationLimit = RateLimitDefinition<'reservation'>;

/** An abuse throttle: never clears, and reserves nothing refundable. */
export type ThrottleLimit = RateLimitDefinition<'throttle'>;
