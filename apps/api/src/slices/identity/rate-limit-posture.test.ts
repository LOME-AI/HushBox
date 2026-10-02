import { describe, expect, expectTypeOf, it } from 'vitest';
import { clear, countedInFlow } from '../../lib/rate-limit/index.js';
import { reachableFrom } from '../../test-support/rate-limit-reachability.js';
import { IDENTITY_ROUTE_POSTURES } from './index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { STEP_UP_GATES } from './domain/session/step-up.js';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from './domain/rate-limit.js';
import type { RateLimitDefinition, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { IdentityRouteKey } from './rate-limit-posture.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Hono } from 'hono';

/** The entries this slice's fragment cites, so the leak walk can name each one. */
const CITED_ENTRIES: readonly RateLimitDefinition[] = [
  loginIpRateLimit,
  registerIpRateLimit,
  recoveryResetIpRateLimit,
  recoveryGetKeyIpRateLimit,
  verifyEmailIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  IDENTITY_KEYS.stepUpLockout,
  IDENTITY_KEYS.deleteAccountInitLockout,
  IDENTITY_KEYS.deleteAccountLockout,
  IDENTITY_KEYS.twoFactorLockout,
  IDENTITY_KEYS.loginLockout,
  IDENTITY_KEYS.loginLockoutPerNetwork,
  IDENTITY_KEYS.registerRateLimit,
  IDENTITY_KEYS.recoveryResetLockout,
  IDENTITY_KEYS.recoveryResetLockoutPerNetwork,
  IDENTITY_KEYS.recoveryGetKeyLockout,
  IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork,
  IDENTITY_KEYS.verifyTokenRateLimit,
  IDENTITY_KEYS.resendVerifyRateLimit,
];

describe('the identity posture fragment', () => {
  it('derives a non-empty route-key union from its own manifest', () => {
    expectTypeOf<IdentityRouteKey>().not.toBeNever();
  });

  it('resolves that union to nothing when the sub-router has erased its schema', () => {
    // The matched control for the assertion above: an annotated sub-router
    // widens to `BlankSchema`, the key union collapses to `never`, and a
    // fragment then satisfies its target vacuously. The pair is what makes the
    // first assertion a discrimination rather than a formality.
    expectTypeOf<SliceRouteKey<{ basePath: '/auth'; routes: Hono<AppEnv> }>>().toBeNever();
  });

  it('declares at least one route', () => {
    expect(Object.keys(IDENTITY_ROUTE_POSTURES).length).toBeGreaterThan(0);
  });
});

describe("the step-up routes' citations", () => {
  it('cites the counter the deletion init actually spends', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/account/delete/init'].countedInFlow).toStrictEqual([
      countedInFlow(STEP_UP_GATES.deleteAccount.lockout),
    ]);
  });

  it('does not cite the shared step-up counter on the deletion init', () => {
    // Deletion's gate is its own so that no other flow's fumble can arm the
    // 24-hour freeze it guards. That separation is what makes THIS citation
    // discriminating, and the three assertions below are what makes the other
    // three non-discriminating.
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/account/delete/init'].countedInFlow).not.toContain(
      countedInFlow(STEP_UP_GATES.changePassword.lockout)
    );
  });

  it('cites a step-up counter on the password-change init', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/change-password/init'].countedInFlow).toStrictEqual(
      [countedInFlow(STEP_UP_GATES.changePassword.lockout)]
    );
  });

  it('cites a step-up counter on the 2FA-disable init', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/2fa/disable/init'].countedInFlow).toStrictEqual([
      countedInFlow(STEP_UP_GATES.twoFactorDisable.lockout),
    ]);
  });

  it('cites a step-up counter on the recovery-save init', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/recovery/save/init'].countedInFlow).toStrictEqual([
      countedInFlow(STEP_UP_GATES.recoverySave.lockout),
    ]);
  });

  it('cannot tell those three gates apart, because they are one entry', () => {
    // The stated ceiling on the three assertions above, measured rather than
    // assumed: change-password, 2FA-disable and recovery-save share ONE lockout
    // object, and the binding factory memoizes on the entry — so each of those
    // assertions proves that A step-up counter is cited, never WHICH gate's.
    expect(STEP_UP_GATES.changePassword.lockout).toBe(STEP_UP_GATES.twoFactorDisable.lockout);
    expect(STEP_UP_GATES.changePassword.lockout).toBe(STEP_UP_GATES.recoverySave.lockout);
    expect(countedInFlow(STEP_UP_GATES.changePassword.lockout)).toBe(
      countedInFlow(STEP_UP_GATES.recoverySave.lockout)
    );
  });

  it('cites both counters the deletion finish spends, in the order it spends them', () => {
    // The deletion gate answers first; a 2FA-enabled account then pays the
    // shared TOTP lockout on the same request. Declaring only the first would
    // understate the route's bound, and `keyedBy` is positional, so the order
    // here is the order the flow charges them in.
    expect(
      IDENTITY_ROUTE_POSTURES['$post /auth/account/delete/finish'].countedInFlow
    ).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.deleteAccountLockout),
      countedInFlow(IDENTITY_KEYS.twoFactorLockout),
    ]);
  });

  it('names one identity per layer on the deletion finish, repeating the shared one', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/account/delete/finish'].keyedBy).toStrictEqual([
      'user',
      'user',
    ]);
  });

  it('gives the deletion finish no edge call, because neither layer is counted there', () => {
    expect(
      IDENTITY_ROUTE_POSTURES['$post /auth/account/delete/finish'].countAtEdge
    ).toBeUndefined();
  });

  it('cites the TOTP lockout, alone, on the login and 2FA-disable verifications', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/login/2fa/verify'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.twoFactorLockout),
    ]);
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/2fa/disable/finish'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.twoFactorLockout),
    ]);
  });
});

describe('the counters keyed on what an unauthenticated caller supplies', () => {
  it('cites both lockouts the login init spends, in the order it spends them', () => {
    // Positional, and the position is load-bearing: the account-wide ceiling
    // is declared first because the counting script attributes a refusal to
    // the first refusing layer.
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/login/init'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.loginLockout),
      countedInFlow(IDENTITY_KEYS.loginLockoutPerNetwork),
    ]);
  });

  it('cites the per-email window the registration init spends', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/register/init'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.registerRateLimit),
    ]);
  });

  it('cites both lockouts the recovery reset init spends, in the order it spends them', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/recovery/reset/init'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.recoveryResetLockout),
      countedInFlow(IDENTITY_KEYS.recoveryResetLockoutPerNetwork),
    ]);
  });

  it('cites both lockouts the wrapped-key read spends, in the order it spends them', () => {
    expect(
      IDENTITY_ROUTE_POSTURES['$post /auth/recovery/get-wrapped-key'].countedInFlow
    ).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.recoveryGetKeyLockout),
      countedInFlow(IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork),
    ]);
  });

  it('names the address ahead of both account windows on the recovery routes', () => {
    // `keyedBy` is positional over every layer wherever it is counted: the edge
    // throttle the pipeline spends comes first, then the account-wide ceiling,
    // then the window for that account within the calling network.
    const layers = ['ip', 'claimed-account', 'claimed-account-per-network'];

    expect(IDENTITY_ROUTE_POSTURES['$post /auth/recovery/get-wrapped-key'].keyedBy).toStrictEqual(
      layers
    );
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/recovery/reset/init'].keyedBy).toStrictEqual(
      layers
    );
  });

  it('cites the per-token window the email verification spends', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/verify-email'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.verifyTokenRateLimit),
    ]);
  });

  it('cites the per-email window the verification resend spends', () => {
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/verify-email/resend'].countedInFlow).toStrictEqual([
      countedInFlow(IDENTITY_KEYS.resendVerifyRateLimit),
    ]);
  });

  it('cites a distinct entry for every counter these routes spend', () => {
    // What lifts these over the step-up-gate citations: every entry named here
    // is a distinct object, so the binding factory memoizes a distinct
    // reference per entry and each assertion reads WHICH counter is cited
    // rather than only that one is.
    const cited = [
      IDENTITY_KEYS.loginLockout,
      IDENTITY_KEYS.loginLockoutPerNetwork,
      IDENTITY_KEYS.registerRateLimit,
      IDENTITY_KEYS.recoveryResetLockout,
      IDENTITY_KEYS.recoveryResetLockoutPerNetwork,
      IDENTITY_KEYS.recoveryGetKeyLockout,
      IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork,
      IDENTITY_KEYS.verifyTokenRateLimit,
      IDENTITY_KEYS.resendVerifyRateLimit,
    ].map((entry) => countedInFlow(entry));

    expect(new Set(cited).size).toBe(cited.length);
  });

  it('names the address ahead of the account on the login init', () => {
    // `keyedBy` is positional over every layer wherever it is counted, so the
    // edge throttle the pipeline spends comes first and the in-flow lockout
    // second.
    expect(IDENTITY_ROUTE_POSTURES['$post /auth/login/init'].keyedBy).toStrictEqual([
      'ip',
      'claimed-account',
      'claimed-account-per-network',
    ]);
  });

  it('leaves the login init edge call spending its address window alone', () => {
    const edge = IDENTITY_ROUTE_POSTURES['$post /auth/login/init'].countAtEdge;
    if (edge === undefined) throw new Error('the login init declares an edge layer');

    expect(edge.keyedBy).toStrictEqual(['ip']);
  });
});

describe('what the identity barrel publishes with the fragment', () => {
  it('descends into what the fragment does publish', () => {
    // The positive control for the assertions below: a walk that reached
    // nothing would report every leak absent and read exactly like a clean one.
    const reachable = reachableFrom(IDENTITY_ROUTE_POSTURES);
    expect(reachable).toContain('user');
    expect(reachable).toContain('ip');
  });

  it('reaches no registry entry the fragment cites', () => {
    const reachable = reachableFrom(IDENTITY_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry);
  });

  it('reaches no key builder', () => {
    const reachable = reachableFrom(IDENTITY_ROUTE_POSTURES);
    for (const entry of CITED_ENTRIES) expect(reachable).not.toContain(entry.buildKey);
  });

  it('reaches no key prefix', () => {
    const strings = reachableFrom(IDENTITY_ROUTE_POSTURES).filter(
      (value) => typeof value === 'string'
    );
    expect(strings.filter((value) => value.includes('ratelimit:'))).toStrictEqual([]);
  });

  it('reaches neither cap nor window', () => {
    const caps = new Set(
      CITED_ENTRIES.flatMap((entry) => [entry.maxAttempts, entry.windowSeconds])
    );
    const numbers = reachableFrom(IDENTITY_ROUTE_POSTURES).filter(
      (value) => typeof value === 'number'
    );
    expect(numbers.filter((value) => caps.has(value))).toStrictEqual([]);
  });

  it('reaches one callable per edge-counted route, and none of them is the disarm', () => {
    const callables = reachableFrom(IDENTITY_ROUTE_POSTURES).filter(
      (value) => typeof value === 'function'
    );
    expect(callables).toHaveLength(7);
    expect(callables).not.toContain(clear);
  });
});
