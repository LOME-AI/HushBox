import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from './domain/rate-limit.js';
import { STEP_UP_GATES } from './domain/session/step-up.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createIdentityManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type IdentityRouteKey = SliceRouteKey<ReturnType<typeof createIdentityManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * Two things about identity make it the hardest shape here.
 *
 * The step-up gates are resolved at runtime, from `STEP_UP_GATES` — so a
 * declaration written anywhere but inside this slice could only name a counter
 * it could not see. Here it cites the very expression the domain consumes, one
 * symbol shared between the declaration and the consume site. What that citation
 * can prove is bounded: change-password, 2FA-disable and recovery-save share ONE
 * lockout entry, so those three resolve to one memoized reference and no test
 * can tell which gate's citation it is reading. Deletion's own gate is separate,
 * and only that one is discriminating.
 *
 * The other hard shape is that most of what this slice counts keys on
 * something the CALLER supplies — a login identifier, a registration or
 * verification email, a recovery identifier, a verification token — and the
 * counter is spent in the flow that resolves it. Those layers are declared
 * with the rest, as flow layers on identities the pipeline cannot resolve —
 * the account a caller claimed, alone or paired with the network the guess
 * came from, and the token a caller presents. The account those windows bound
 * is the one an attacker is guessing at, which is the bound an address-keyed
 * layer cannot supply against a botnet.
 *
 * On the failure axis this slice splits by what a route touches rather than by
 * how it is bounded, and each route class its rows carry has its ground stated
 * here. Every unauthenticated credential surface a production caller can reach
 * declares `closed` — the counter is the only thing between an outage and
 * password, TOTP, recovery-phrase or token guessing, and one of them admits
 * requests that can send mail we pay for. That set spans two route classes:
 * the public auth routes, and the login-2FA verify, whose `pending-2fa` class
 * admits a caller holding no session at all. The OPAQUE `finish` routes on the public class
 * declare `closed` with them: what they admit reads pending state from the same
 * store a counter failure implicates, so an admission buys a caller nothing but
 * a different error. The dev-only verify-token read hands back a verification
 * token and declares `open`, and it is one no production caller reaches: its
 * class answers 404 at the authorizer, ahead of the stage that spends the
 * counter.
 *
 * Logout is `pending-2fa`-classed too, and declares `open`. It lets a caller
 * guess at nothing: one holding no session only has its cookie cleared, one
 * holding a session revokes its own — so an admitted flood buys a cookie
 * header and at most one Redis delete apiece, while refusing would stop a
 * caller ending its own session for the length of a degradation.
 *
 * The session-classed rows split on that same axis. Those taking their route
 * class's default declare `open` — a caller there is one authenticated
 * account, and refusing would take 2FA setup, a caller's read of its own
 * session, or the closing round of a change-password or recovery-save
 * handshake away from a signed-in user during a degradation. Those carrying a
 * flow-counted lockout of their own declare `closed`: every one of those
 * counters is a reservation cleared on success, metering guesses at the
 * account's own credentials — the password an OPAQUE step-up answers, and the
 * TOTP code a 2FA disable or a deletion also demands — and holding a session
 * proves neither of those, so an outage must not hand a session thief
 * unbounded attempts at the gate.
 */
export const IDENTITY_ROUTE_POSTURES = {
  '$post /auth/2fa/disable/finish': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.twoFactorCeiling },
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.twoFactorLockout },
    ],
  }),
  '$post /auth/2fa/disable/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: STEP_UP_GATES.twoFactorDisable.lockout },
    ],
  }),
  '$post /auth/2fa/setup': { kind: 'default', failure: 'open' },
  '$post /auth/2fa/verify': { kind: 'default', failure: 'open' },
  // The channel prompt's two calls. Both take the session class's default and
  // declare `open`: a caller here is one authenticated account answering an
  // optional question about itself, and refusing during a counter degradation
  // would take a growth prompt away from a signed-in user while buying a
  // guesser nothing — neither call reads or writes a credential, and the write
  // converges on itself.
  '$get /auth/account/acquisition-source': { kind: 'default', failure: 'open' },
  '$patch /auth/account/acquisition-source': { kind: 'default', failure: 'open' },
  // Three layers on one identity: the deletion gate always, then the shared
  // TOTP ceiling and window when the account has 2FA. `keyedBy` is positional,
  // so each repeated 'user' is its own layer rather than a duplicate to fold away.
  '$post /auth/account/delete/finish': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.deleteAccountLockout },
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.twoFactorCeiling },
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.twoFactorLockout },
    ],
  }),
  '$post /auth/account/delete/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: STEP_UP_GATES.deleteAccount.lockout },
    ],
  }),
  '$post /auth/change-password/finish': { kind: 'default', failure: 'open' },
  '$post /auth/change-password/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: STEP_UP_GATES.changePassword.lockout },
    ],
  }),
  '$post /auth/login/2fa/verify': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.twoFactorCeiling },
      { identity: 'user', countedAt: 'flow', definition: IDENTITY_KEYS.twoFactorLockout },
    ],
  }),
  '$post /auth/login/finish': { kind: 'default', failure: 'closed' },
  '$post /auth/login/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: loginIpRateLimit },
      { identity: 'claimed-account', countedAt: 'flow', definition: IDENTITY_KEYS.loginLockout },
      {
        identity: 'claimed-account-per-network',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.loginLockoutPerNetwork,
      },
    ],
  }),
  '$post /auth/logout': { kind: 'default', failure: 'open' },
  '$get /auth/me': { kind: 'default', failure: 'open' },
  '$post /auth/recovery/get-wrapped-key': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: recoveryGetKeyIpRateLimit },
      {
        identity: 'claimed-account',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.recoveryGetKeyLockout,
      },
      {
        identity: 'claimed-account-per-network',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork,
      },
    ],
  }),
  '$post /auth/recovery/reset/finish': { kind: 'default', failure: 'closed' },
  '$post /auth/recovery/reset/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: recoveryResetIpRateLimit },
      {
        identity: 'claimed-account',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.recoveryResetLockout,
      },
      {
        identity: 'claimed-account-per-network',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.recoveryResetLockoutPerNetwork,
      },
    ],
  }),
  '$post /auth/recovery/save/finish': { kind: 'default', failure: 'open' },
  '$post /auth/recovery/save/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'user', countedAt: 'flow', definition: STEP_UP_GATES.recoverySave.lockout },
    ],
  }),
  '$post /auth/register/finish': { kind: 'default', failure: 'closed' },
  '$post /auth/register/init': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: registerIpRateLimit },
      {
        identity: 'claimed-account',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.registerRateLimit,
      },
    ],
  }),
  '$post /auth/token-login': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: tokenLoginIpRateLimit }],
  }),
  '$get /auth/verify-email/dev-link': { kind: 'default', failure: 'open' },
  '$post /auth/verify-email/resend': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: resendVerifyIpRateLimit },
      {
        identity: 'claimed-account',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.resendVerifyRateLimit,
      },
    ],
  }),
  '$post /auth/verify-email': bindRoutePosture({
    failure: 'closed',
    layers: [
      { identity: 'ip', countedAt: 'edge', definition: verifyEmailIpRateLimit },
      {
        identity: 'presented-token',
        countedAt: 'flow',
        definition: IDENTITY_KEYS.verifyTokenRateLimit,
      },
    ],
  }),
} satisfies Record<IdentityRouteKey, CarriedRoutePosture>;
