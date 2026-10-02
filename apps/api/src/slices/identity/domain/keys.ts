import { z } from 'zod';
import {
  BILLING_PORTAL_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
} from '../../../lib/context/index.js';
import { defineKey } from '../../../lib/redis/index.js';
import { compositeRateLimitId, rateLimitKey } from '../../../lib/rate-limit/index.js';
import type { ReservationLimit, ThrottleLimit } from '../../../lib/rate-limit/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The per-request Redis client as the pipeline types it — named here because
 * this `domain/` layer is refused the infra module itself. Which layers the ban
 * covers is stated in `packages/config/eslint-extensions/boundaries.config.mjs`.
 */
export type RedisClient = Variables['redis'];

/**
 * What a flow that produces a registration record pins at its init round and
 * writes verbatim at its finish: the per-user OPAQUE server material the
 * record was produced on, sealed under the KEK, and that KEK's fingerprint. A
 * finish round never re-reads the KEK — a swap between the two rounds refuses
 * on the fingerprint rather than stamping a record with material it was not
 * produced under.
 */
const serverMaterialPinShape = {
  serverMaterial: z.array(z.number()),
  kekFingerprint: z.array(z.number()),
};

/**
 * The password-change pin: the material pin plus the registration record the
 * init round observed, which the finish round's compare-and-swap asserts.
 */
export const passwordRotationPinSchema = z.object({
  observedRegistration: z.array(z.number()),
  ...serverMaterialPinShape,
});

/**
 * Shared shape of every OPAQUE step-up handshake's stored state. The userId
 * rides in the value so the finish round rejects a stolen handshake id bound
 * to another account; `expectedSerialized` is the OPAQUE expected-auth-result.
 * `rotation` is carried only by the step-up whose finish rewrites the record.
 */
export const stepUpPendingSchema = z.object({
  userId: z.string(),
  expectedSerialized: z.array(z.number()),
  rotation: passwordRotationPinSchema.optional(),
});

/**
 * The identity slice's Redis registry entries.
 *
 * OPAQUE handshake state is keyed by a server-issued UUID, never by the
 * identifier: the identifier moves into the stored value so the finish step
 * can verify it matches the request (defense-in-depth against a stolen
 * handshake id), and per-identifier keying would let two concurrent
 * handshakes clobber each other's `expected` value.
 *
 * Session keys mirror the legacy key shapes exactly — production cookies
 * sealed before the cutover must keep resolving to the same Redis entries.
 */
export const IDENTITY_KEYS = {
  opaquePendingRegistration: defineKey({
    schema: z.object({
      email: z.string(),
      username: z.string(),
      userId: z.string(),
      ...serverMaterialPinShape,
      existing: z.boolean().optional(),
    }),
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:pending:${handshakeId}`,
  }),
  opaquePendingLogin: defineKey({
    schema: z.object({
      identifier: z.string(),
      userId: z.string().nullable(),
      expectedSerialized: z.array(z.number()),
    }),
    ttlSeconds: 120,
    buildKey: (handshakeId: string) => `opaque:login:${handshakeId}`,
  }),
  // Coerced: the Upstash client JSON-parses stored values, so '1' returns as
  // the number 1.
  sessionActive: defineKey({
    schema: z.coerce.string(),
    ttlSeconds: SESSION_MAX_AGE_SECONDS,
    buildKey: (userId: string, sessionId: string) => `sessions:user:active:${userId}:${sessionId}`,
  }),
  passwordChangedAt: defineKey({
    schema: z.coerce.number(),
    ttlSeconds: SESSION_MAX_AGE_SECONDS,
    buildKey: (userId: string) => `auth:pw-changed:${userId}`,
  }),
  // Liveness of an issued billing-portal credential — the handoff's own
  // `sessionActive` counterpart, on its own prefix because the credential is a
  // different kind from the login session and revoking one must not reach the
  // other. The pw-changed watermark above IS shared: account lock, deletion and
  // chargeback already revoke through it, so the handoff dies with them without
  // a second watermark for a future revocation source to forget.
  billingPortalActive: defineKey({
    schema: z.coerce.string(),
    ttlSeconds: BILLING_PORTAL_MAX_AGE_SECONDS,
    buildKey: (userId: string, sessionId: string) => `billing:portal:active:${userId}:${sessionId}`,
  }),
  // Billing-portal login token (mobile app → web billing handoff). Keyed by
  // the token itself and NEVER deleted on redemption: the 60-second TTL is the
  // expiry, and replays within it converge on the same deterministic credential
  // (token-is-key idempotency).
  billingLoginToken: defineKey({
    schema: z.object({ userId: z.string() }),
    ttlSeconds: 60,
    buildKey: (token: string) => `billing:login-token:${token}`,
  }),
  // Password-login's two failed-attempt counters, spent together as one
  // all-or-nothing layered check. Both key on the user id when the identifier
  // resolves to an account (unifying email and username into one guessing
  // budget) else on the lowercased canonical identifier; both are reservations,
  // because the surface is offline-attackable secret guessing, and a verified
  // login clears both.
  //
  // `loginLockout` is the ACCOUNT-WIDE ceiling: the brute-force bound, which a
  // per-network window cannot supply against a botnet.
  //
  // Sizing, which `docs/RATE-LIMITING.md` §"IP layers are earned, not
  // defaulted" requires to be written rather than defaulted: ten networks times
  // the per-network cap. The judgement it encodes is how many networks one
  // account's legitimate sign-ins plausibly come from — a person's phone,
  // home line and office are three, so ten is well clear of that while an
  // honest caller meets the per-network cap first and never this one. What it
  // costs the attacker is the same multiple: ten distinct addresses to hold one
  // account out of login for a window, where one address sufficed. What it
  // buys the attacker is that a distributed guesser gets 4,800 attempts per
  // account per day against the 480 a single per-network-sized window allowed
  // — an order of magnitude below what the password's own entropy withstands,
  // and the price of the denial channel being closed.
  loginLockout: {
    kind: 'reservation',
    maxAttempts: 50,
    windowSeconds: 900,
    buildKey: (identifier: string) => `ratelimit:identity:login:lockout:${identifier}`,
  } as const satisfies ReservationLimit,
  // The window a guess actually meets: one named account AND the network it
  // came from, as one composite identifier (`compositeRateLimitId`), so what
  // one network spends is its own. A window keyed on the account alone is
  // spendable in full from a single address, which is how naming an account
  // becomes a way to lock its owner out of login. Five is a person's plausible
  // mistypes of a password they know, from one network, so this is the window an
  // honest caller meets first and the ceiling above is one it never reaches.
  loginLockoutPerNetwork: {
    kind: 'reservation',
    maxAttempts: 5,
    windowSeconds: 900,
    buildKey: (composite: string) => `ratelimit:identity:login:lockout-per-network:${composite}`,
  } as const satisfies ReservationLimit,
  // Registration attempts per email address. A throttle: an email address is
  // not a secret being guessed, and nothing clears it.
  registerRateLimit: {
    kind: 'throttle',
    maxAttempts: 3,
    windowSeconds: 3600,
    buildKey: (email: string) => `ratelimit:identity:register:email:${email}`,
  } as const satisfies ThrottleLimit,
  // TOTP enrollment: the fresh secret held (plaintext + its encrypted blob)
  // between setup and the confirming verify. Single-use — the verify consumes
  // it via `redisGetDel` so a replayed confirmation cannot re-enable.
  //
  // Deliberate: the plaintext secret exists in Redis for this 300-second
  // pending-setup window only (the confirming code must be checked against
  // it, and Redis is ephemeral coordination, never durable truth). The
  // durable store persists only `totpSecretEncrypted`.
  totpPendingSetup: defineKey({
    schema: z.object({
      secret: z.string(),
      encryptedBlob: z.array(z.number()),
    }),
    ttlSeconds: 300,
    buildKey: (userId: string) => `totp:pending:${userId}`,
  }),
  // Consumed-code marker for TOTP replay protection: a code accepted once
  // cannot be reused inside its validity window. Coerced (Upstash JSON-parses).
  totpUsedCode: defineKey({
    schema: z.coerce.string(),
    ttlSeconds: 120,
    buildKey: (userId: string, code: string) => `totp:used:${userId}:${code}`,
  }),
  // OPAQUE step-up handshake state for the sensitive authenticated ops. Keyed
  // by a server-issued handshake id (never userId) so concurrent step-ups for
  // one user cannot clobber each other's `expected`; the userId rides in the
  // value so the finish round rejects a stolen handshake id bound to another
  // account.
  opaquePendingChangePassword: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:change-password:${handshakeId}`,
  }),
  opaquePending2FADisable: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:2fa-disable:${handshakeId}`,
  }),
  opaquePendingDeleteAccount: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:delete-account:${handshakeId}`,
  }),
  // Recovery-material save step-up. A distinct key prefix per feature is what
  // stops a handshake minted for one sensitive op from finishing another: the
  // finish round resolves its handshake id under its own feature's key only.
  opaquePendingRecoverySave: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:recovery-save:${handshakeId}`,
  }),
  // Recovery reset handshake. The recovery phrase never reaches the server —
  // the client rewraps its key locally — so the record carries the identifier
  // plus the base64 single-use challenge nonce the finish round's proof is
  // recomputed from. The nonce living INSIDE this record is what makes the
  // proof comparison ride the same atomic GETDEL claim: a failed proof has
  // already consumed the handshake, so nothing can be guessed against a live
  // nonce.
  opaquePendingRecoveryReset: defineKey({
    schema: z.object({ identifier: z.string(), nonce: z.string(), ...serverMaterialPinShape }),
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:recovery-reset:${handshakeId}`,
  }),
  // Email verification-resend throttle, per email (legacy parity: 1 per
  // 60 seconds). The per-IP dimension is a separate edge-counted entry
  // (domain/rate-limit.ts) — legacy dual-limited this surface.
  resendVerifyRateLimit: {
    kind: 'throttle',
    maxAttempts: 1,
    windowSeconds: 60,
    buildKey: (email: string) => `ratelimit:identity:resend-verify:email:${email}`,
  } as const satisfies ThrottleLimit,
  // Email-verification token-consume throttle, per token (legacy parity:
  // 10 per hour). A throttle — the token is single-use, so this only bounds
  // repeated consume attempts on one token; the per-IP dimension is a
  // separate edge-counted entry (domain/rate-limit.ts).
  verifyTokenRateLimit: {
    kind: 'throttle',
    maxAttempts: 10,
    windowSeconds: 3600,
    buildKey: (token: string) => `ratelimit:identity:verify-email:token:${token}`,
  } as const satisfies ThrottleLimit,
  // The wrapped-key read's two failed-attempt counters, spent together as one
  // all-or-nothing layered check. Both key on the canonical identifier the
  // caller named, never on an account: every response is identical by design
  // (enumeration safety), so a known and an unknown identifier must reach the
  // same counters. The returned blob is offline-attackable ciphertext, so
  // retrieval is a secret-guessing surface and both are reservations. Nothing
  // clears either — there is no verified success to clear on, since the server
  // cannot tell one caller here from another; the windows simply expire.
  //
  // `recoveryGetKeyLockout` is the ACCOUNT-WIDE ceiling: the bound on how many
  // copies of one account's blob a distributed caller can collect, which a
  // per-network window cannot supply against a botnet.
  //
  // Sizing, which `docs/RATE-LIMITING.md` §"IP layers are earned, not
  // defaulted" requires to be written rather than defaulted: ten networks
  // times the per-network cap. The judgement it encodes is recovery's own,
  // which is not login's: recovery is a rare act reached by someone already
  // locked out, working through a phrase written on paper from the one device
  // in front of them, so the honest caller meets the per-network window and
  // nothing wider. Ten networks is chosen for what it costs an attacker rather
  // than for what it allows the owner — ten distinct addresses to hold an
  // account out of recovery for an hour, where one address sufficed. What it
  // buys the attacker is thirty copies of a blob per hour rather than three,
  // and the blob is the same bytes every time: an offline attack needs one
  // copy, so widening this ceiling hands a guesser nothing it did not already
  // have.
  recoveryGetKeyLockout: {
    kind: 'reservation',
    maxAttempts: 30,
    windowSeconds: 3600,
    buildKey: (identifier: string) => `ratelimit:identity:recovery-getkey:lockout:${identifier}`,
  } as const satisfies ReservationLimit,
  // The window a wrapped-key read actually meets: one named identifier AND the
  // network it came from, as one composite identifier
  // ({@link recoveryNetworkLockoutId}), so what one network spends is its own.
  // A window keyed on the identifier alone is spendable in full from a single
  // address, which is how naming an account becomes a way to hold its owner
  // out of recovery — the surface that owner reaches for precisely when
  // already locked out of login. Three is what someone reading a written
  // phrase back needs from one device, so this is the window an honest caller
  // meets first and `recoveryGetKeyLockout` is one it never reaches.
  recoveryGetKeyLockoutPerNetwork: {
    kind: 'reservation',
    maxAttempts: 3,
    windowSeconds: 3600,
    buildKey: (composite: string) =>
      `ratelimit:identity:recovery-getkey:lockout-per-network:${composite}`,
  } as const satisfies ReservationLimit,
  // The reset init's two counters, the same layered pair on the same identifier
  // and reservations for the same reason. The recovery phrase never leaves the
  // client, so no reset outcome is a verified success and neither counter is
  // ever cleared — the windows simply expire.
  //
  // `recoveryResetLockout` is the ACCOUNT-WIDE ceiling, sized on the same
  // judgement about recovery that `recoveryGetKeyLockout` records: ten
  // networks times the per-network cap, chosen for the attacker's cost rather
  // than the owner's need. What it buys that attacker is thirty attempts at
  // the recovery phrase per hour rather than three — each one a fresh sealed
  // challenge, since a wrong proof has already burned its nonce and a retry
  // costs another init this window counts. Against a twelve-word BIP39 phrase
  // the difference between three and thirty is not measurable, which is why
  // the denial channel is the side of this trade worth closing.
  recoveryResetLockout: {
    kind: 'reservation',
    maxAttempts: 30,
    windowSeconds: 3600,
    buildKey: (identifier: string) => `ratelimit:identity:recovery-reset:lockout:${identifier}`,
  } as const satisfies ReservationLimit,
  // The window a reset attempt actually meets: one named identifier AND the
  // network it came from. A window keyed on the identifier alone is spendable
  // in full from a single address, which is how naming an account becomes a way
  // to hold its owner out of the reset flow for an hour. Three is sized on this
  // round's own terms — a reset is retried by re-reading a written phrase
  // rather than by guessing at it, so a caller who needs a fourth attempt
  // inside the hour is not the owner working from one device.
  recoveryResetLockoutPerNetwork: {
    kind: 'reservation',
    maxAttempts: 3,
    windowSeconds: 3600,
    buildKey: (composite: string) =>
      `ratelimit:identity:recovery-reset:lockout-per-network:${composite}`,
  } as const satisfies ReservationLimit,
  // TOTP-verify lockout: failed-attempt counter. After `maxAttempts` failures
  // inside the TTL window the account's 2FA verification is locked for the
  // rest of it; a success clears the window (legacy parity: 10 attempts /
  // 15 min).
  twoFactorLockout: {
    kind: 'reservation',
    maxAttempts: 10,
    windowSeconds: 900,
    buildKey: (userId: string) => `ratelimit:identity:totp:lockout:${userId}`,
  } as const satisfies ReservationLimit,
  // The step-up guessing gate shared by change-password, 2FA-disable and
  // recovery-save: one budget for one secret, since the same password opens all
  // three and a per-flow counter would hand an attacker three times the guesses.
  //
  // Spent at the INIT round, which is where an OPAQUE guess is actually
  // answered: the KE2 init returns IS the answer, verified client-side, so a
  // wrong password never produces a finish call and a finish-side counter would
  // meter an endpoint no attacker has reason to touch. The increment is
  // therefore the gate — at most `maxAttempts` handshakes are ever minted, even
  // under concurrency — and a verified step-up clears it (secret-guessing
  // class). Five guesses per window is sized on this surface's own terms: the
  // caller already holds a session, so the budget covers a person mistyping a
  // password they know and nothing wider. It is deliberately not tied to the
  // login ceiling, which answers a different question — how many networks one
  // account's sign-ins plausibly come from — and stands an order of magnitude
  // higher for that reason alone.
  //
  // Account deletion is deliberately NOT on this counter: it meters at both
  // rounds (the finish round is where its 24-hour freeze arms), and that
  // freeze is a severity which must not be reachable from an unrelated flow's
  // password fumble.
  stepUpLockout: {
    kind: 'reservation',
    maxAttempts: 5,
    windowSeconds: 900,
    buildKey: (userId: string) => `ratelimit:identity:step-up:lockout:${userId}`,
  } as const satisfies ReservationLimit,
  // Account deletion's password-guessing gate, spent at its INIT round for the
  // same protocol reason `stepUpLockout` is: the KE2 that round returns IS the
  // answer to the guess, so an ungated init is an unbounded password oracle to
  // anyone holding a session, whatever the finish round counts.
  //
  // A key of deletion's OWN rather than the shared one, because exhausting a
  // deletion counter is a severity no unrelated flow may reach: only deletion's
  // own failures arm its 24-hour freeze. The cap matches `stepUpLockout` — the
  // same secret, guessed the same way, one round apart.
  //
  // Cleared on a proven password (secret-guessing class), including on the
  // wrong-confirmation-phrase path, which is the finish gate's carve-out applied
  // to the counter that meters guesses: reaching finish at all means the
  // password verified client-side, so a mistyped phrase must not cost a guess.
  deleteAccountInitLockout: {
    kind: 'reservation',
    maxAttempts: 5,
    windowSeconds: 900,
    buildKey: (userId: string) => `ratelimit:identity:delete-account:init-lockout:${userId}`,
  } as const satisfies ReservationLimit,
  // Account-deletion guessing gate: the atomic attempt-reservation counter for
  // failed deletion step-ups within a 1-hour window (a secret-guessing surface,
  // so the increment is itself the gate; a verified deletion clears it).
  // Exhausting this gate engages the separate 24-hour `deleteAccountHardLock`.
  // This is the tight guessing gate of legacy's two-mechanism split — the two
  // were briefly merged into a single 24-hour window, so a short fumble froze
  // deletion for a full day; the split restores the 1-hour accumulation window.
  //
  // `maxAttempts: 2` reproduces legacy's `count >= 3` lock (legacy
  // `rate-limit.ts:180`, which recorded the failure AFTER verifying): the
  // reserve-before-verify gate admits exactly `maxAttempts` before locking the
  // next, so a budget of 2 makes the 3rd consecutive failed step-up the one that
  // engages the lock — parity with legacy's 3rd-failure trigger.
  deleteAccountLockout: {
    kind: 'reservation',
    maxAttempts: 2,
    windowSeconds: 3600,
    buildKey: (userId: string) => `ratelimit:identity:delete-account:lockout:${userId}`,
  } as const satisfies ReservationLimit,
  // Account-deletion 24-hour hard lock: a presence key engaged when the 1-hour
  // guessing gate above is exhausted by repeated failure. Its TTL is the freeze
  // duration; it is read (never incremented) before every deletion attempt and
  // cleared on a verified deletion. Separate from the guessing gate so only
  // sustained abuse — not a fumbled short sequence — freezes deletion for a day
  // (legacy's `delete-account:lockout` 24-hour lock, restored alongside its
  // guessing gate).
  deleteAccountHardLock: defineKey({
    schema: z.coerce.number(),
    ttlSeconds: 86_400,
    buildKey: (userId: string) => `delete-account:hard-lock:${userId}`,
  }),
} as const;

/**
 * The identifier the per-network login lockout counts: the account identifier
 * the ceiling keys on, composited with the caller's address identity.
 *
 * The single derivation of that pair, because two callers depend on producing
 * the same one — the login flow, which spends the window, and the dev auth
 * reset, which clears it. Two spellings of which parts in which order would
 * leave the reset deleting a key nothing ever writes, and nothing downstream
 * could tell: a digest is opaque to the counter cross-check, which compares
 * key PREFIXES.
 */
export function loginNetworkLockoutId(account: string, callerNetworkId: string): Promise<string> {
  return compositeRateLimitId([account, callerNetworkId]);
}

/**
 * That counter's Redis key, for the dev reset that clears it by name, built by
 * the encoder `consume` itself keys with, so it is the key the flow spends.
 * Unwrapped because the encoder's one error arm is an identifier past its
 * length bound, and a composite is one digest wide by construction.
 */
export async function loginNetworkLockoutKey(
  account: string,
  callerNetworkId: string
): Promise<string> {
  return rateLimitKey(
    IDENTITY_KEYS.loginLockoutPerNetwork,
    await loginNetworkLockoutId(account, callerNetworkId)
  )._unsafeUnwrap();
}

/**
 * The identifier both per-network recovery lockouts count: the canonical
 * identifier the account-wide ceilings key on, composited with the caller's
 * network identity.
 *
 * One derivation shared by the two windows and by the dev auth reset that
 * clears them, because those callers depend on producing the same digest and a
 * second spelling of which parts in which order would leave the reset deleting
 * a key nothing ever writes — a digest is opaque to the counter cross-check,
 * which compares key PREFIXES. The two windows stay distinct counters on that
 * shared digest: they carry different key prefixes, which is what a reader
 * checking whether one flow can spend the other's window needs to know.
 */
export function recoveryNetworkLockoutId(
  canonical: string,
  callerNetworkId: string
): Promise<string> {
  return compositeRateLimitId([canonical, callerNetworkId]);
}

/**
 * Both of those counters' Redis keys, for the dev reset that clears them by
 * name, built by the encoder `consume` itself keys with and unwrapped for the
 * reason {@link loginNetworkLockoutKey} gives. Answered together because the
 * reset clears them together: a caller refused on one of recovery's two rounds
 * has the other to get past as well.
 */
export async function recoveryNetworkLockoutKeys(
  canonical: string,
  callerNetworkId: string
): Promise<readonly string[]> {
  const composite = await recoveryNetworkLockoutId(canonical, callerNetworkId);
  return [
    rateLimitKey(IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork, composite)._unsafeUnwrap(),
    rateLimitKey(IDENTITY_KEYS.recoveryResetLockoutPerNetwork, composite)._unsafeUnwrap(),
  ];
}
