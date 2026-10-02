import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import {
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  ERROR_CODES,
  WELCOME_CREDIT_CENTS,
  centsToNanoUsd,
} from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/account/billing-portal.js';
import { checkSessionRevocation, createIdentityManifest, createIdentityStores } from './index.js';
import {
  KEY_BLOBS,
  NEW_WRAPPED_KEY,
  PREFIX,
  createApp,
  db,
  emailPortFailure,
  enrollTotp,
  expectStatus,
  get,
  login,
  manifestDeps,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sessionCookieOf,
  stepUpKe3,
  testEnv,
  wrongCode,
} from './routes.integration.setup.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { IdentityRouteDeps, IdentityStores } from './index.js';

/**
 * Distinct documentation-range addresses (RFC 5737 TEST-NET-3), one per index —
 * each /32 is its own network, so a counter keyed in part on the caller's
 * network tells them apart. Derived from an index rather than written as named
 * constants because the ceiling races spread over as many networks as
 * {@link networksFor} derives from the registry's own caps.
 */
function networkAddress(index: number): string {
  return `203.0.113.${String(index + 1)}`;
}

function getWrappedKeyFrom(identifier: string, address: string): Promise<Response> {
  return post('/auth/recovery/get-wrapped-key', { identifier }, undefined, {
    headers: { 'x-forwarded-for': address },
  });
}

function resetInitFrom(
  identifier: string,
  newRegistrationRequest: number[],
  address: string
): Promise<Response> {
  return post('/auth/recovery/reset/init', { identifier, newRegistrationRequest }, undefined, {
    headers: { 'x-forwarded-for': address },
  });
}

/**
 * How many networks a burst of `attempts` must be spread over for no single
 * network's own window to refuse — so the account-wide ceiling is the only
 * layer that can.
 */
function networksFor(attempts: number, perNetworkCap: number): number {
  return Math.ceil(attempts / perNetworkCap);
}

describe('identity routes: edge states for coverage', () => {
  it('returns 500 when a TOTP-enabled account has no configured secret at login 2FA', async () => {
    const { account } = await registerLoginFull();
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: null })
      .where(eq(users.id, account.userId));
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post('/auth/login/2fa/verify', { code: '123456' }, pendingCookie);
    expect(verify.status).toBe(500);
  });

  it('treats an undecryptable stored TOTP secret as a defect (500)', async () => {
    const { account } = await registerLoginFull();
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([1, 2, 3]) })
      .where(eq(users.id, account.userId));
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post('/auth/login/2fa/verify', { code: '123456' }, pendingCookie);
    expect(verify.status).toBe(500);
  });

  it('treats a vanished authenticated user as a defect on TOTP setup', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await post('/auth/2fa/setup', {}, cookie);
    expect(res.status).toBe(500);
  });

  it('returns 500 disabling TOTP whose secret is missing after a valid step-up', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: '123456', disable2FASessionId: initBody.disable2FASessionId },
      cookie
    );
    expect(finish.status).toBe(500);
  });

  it('leaves another address able to read the wrapped key after one address exhausts its window', async () => {
    const identifier = `${PREFIX}getkeynet@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(getWrappedKeyFrom(identifier, networkAddress(0)), 200);
    }

    await expectStatus(getWrappedKeyFrom(identifier, networkAddress(0)), 429);
    await expectStatus(getWrappedKeyFrom(identifier, networkAddress(1)), 200);
  });

  it('leaves the account-wide wrapped-key counter unspent by the request its own network refused', async () => {
    const identifier = `${PREFIX}getkeylayer@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(getWrappedKeyFrom(identifier, networkAddress(0)), 200);
    }

    await expectStatus(getWrappedKeyFrom(identifier, networkAddress(0)), 429);

    expect(
      await redis.get(rateLimitKey(IDENTITY_KEYS.recoveryGetKeyLockout, identifier)._unsafeUnwrap())
    ).toBe(maxAttempts);
  });

  it('admits exactly the attempts the account-wide wrapped-key window still owes, under concurrency', async () => {
    // Seeded near the cap rather than raced from cold: admission is
    // `not (spent + 1 <= cap)` inside one atomic script, so the counter's
    // starting value is a free parameter, and a cap-sized burst spends one
    // bounded round trip per attempt to prove no more of the property.
    const identifier = `${PREFIX}getkeyceiling@identity-routes.test`;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.recoveryGetKeyLockout;
    const headroom = 2;
    const overshoot = 2;
    const attempts = headroom + overshoot;
    const networks = networksFor(
      attempts,
      IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork.maxAttempts
    );
    await redis.set(
      rateLimitKey(IDENTITY_KEYS.recoveryGetKeyLockout, identifier)._unsafeUnwrap(),
      maxAttempts - headroom,
      { ex: windowSeconds }
    );

    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        getWrappedKeyFrom(identifier, networkAddress(index % networks))
      )
    );

    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(headroom);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('leaves another address able to start a reset after one address exhausts its window', async () => {
    const identifier = `${PREFIX}resetnet@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryResetLockoutPerNetwork;
    const { serialized } = await opaqueClientStartRegistration(
      createOpaqueClient(),
      'net reset pw'
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(resetInitFrom(identifier, serialized, networkAddress(0)), 200);
    }

    await expectStatus(resetInitFrom(identifier, serialized, networkAddress(0)), 429);
    await expectStatus(resetInitFrom(identifier, serialized, networkAddress(1)), 200);
  });

  it('leaves the account-wide reset counter unspent by the request its own network refused', async () => {
    const identifier = `${PREFIX}resetlayer@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryResetLockoutPerNetwork;
    const { serialized } = await opaqueClientStartRegistration(
      createOpaqueClient(),
      'layer reset pw'
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(resetInitFrom(identifier, serialized, networkAddress(0)), 200);
    }

    await expectStatus(resetInitFrom(identifier, serialized, networkAddress(0)), 429);

    expect(
      await redis.get(rateLimitKey(IDENTITY_KEYS.recoveryResetLockout, identifier)._unsafeUnwrap())
    ).toBe(maxAttempts);
  });

  it('admits exactly the attempts the account-wide reset window still owes, under concurrency', async () => {
    const identifier = `${PREFIX}resetceiling@identity-routes.test`;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.recoveryResetLockout;
    const headroom = 2;
    const overshoot = 2;
    const attempts = headroom + overshoot;
    const networks = networksFor(
      attempts,
      IDENTITY_KEYS.recoveryResetLockoutPerNetwork.maxAttempts
    );
    const { serialized } = await opaqueClientStartRegistration(
      createOpaqueClient(),
      'ceiling reset pw'
    );
    await redis.set(
      rateLimitKey(IDENTITY_KEYS.recoveryResetLockout, identifier)._unsafeUnwrap(),
      maxAttempts - headroom,
      { ex: windowSeconds }
    );

    const responses = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        resetInitFrom(identifier, serialized, networkAddress(index % networks))
      )
    );

    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(headroom);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('locks out the wrapped-key read from one address at the per-network cap, counting reserved attempts', async () => {
    const identifier = `${PREFIX}getkey@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(getWrappedKeyFrom(identifier, networkAddress(0)), 200);
    }
    // Reserved, not verified: nothing about these reads proved the caller
    // holds anything, and the counter carries all of them anyway.
    expect(
      await redis.get(rateLimitKey(IDENTITY_KEYS.recoveryGetKeyLockout, identifier)._unsafeUnwrap())
    ).toBe(maxAttempts);
    await expectStatus(getWrappedKeyFrom(identifier, networkAddress(0)), 429);
  });

  it('admits exactly the per-network cap under concurrent wrapped-key reads from one address', async () => {
    const identifier = `${PREFIX}getkeyrace@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork;
    const overshoot = 3;
    const responses = await Promise.all(
      Array.from({ length: maxAttempts + overshoot }, () =>
        getWrappedKeyFrom(identifier, networkAddress(0))
      )
    );
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('locks out the reset init from one address at the per-network cap', async () => {
    const identifier = `${PREFIX}resetlim@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryResetLockoutPerNetwork;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'rate limited pw');
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(resetInitFrom(identifier, serialized, networkAddress(0)), 200);
    }
    await expectStatus(resetInitFrom(identifier, serialized, networkAddress(0)), 429);
  });

  it('admits exactly the per-network cap under concurrent reset inits from one address', async () => {
    const identifier = `${PREFIX}resetrace@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryResetLockoutPerNetwork;
    const overshoot = 3;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'rate limited pw');
    const responses = await Promise.all(
      Array.from({ length: maxAttempts + overshoot }, () =>
        resetInitFrom(identifier, serialized, networkAddress(0))
      )
    );
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('still answers success when the verification email send fails (best-effort)', async () => {
    const account = await registerAccount();
    emailPortFailure.shouldFail = true;
    try {
      const res = await post('/auth/verify-email/resend', { email: account.email });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    } finally {
      emailPortFailure.shouldFail = false;
    }
  });
});

describe('identity routes: more edge states for coverage', () => {
  it('treats a vanished user as a defect on change-password init', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const { serialized } = await opaqueClientStartRegistration(createOpaqueClient(), 'x');
    const res = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(res.status).toBe(500);
  });

  it('treats a vanished user as a defect on 2FA disable init', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    await db.delete(users).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    expect(res.status).toBe(500);
  });

  it('treats a vanished user as a defect on account-deletion init', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/account/delete/init', { ke1 }, cookie);
    expect(res.status).toBe(500);
  });

  it('rejects a change-password finish with a stale session id as no-step-up', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'stale pw change');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{ ke2: number[]; newRegistrationResponse: number[] }>();
    const { ke3 } = await opaqueClientFinishLogin(
      stepClient,
      initBody.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post(
      '/auth/change-password/finish',
      {
        ke3,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: crypto.randomUUID(),
      },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('collapses a cross-account 2FA-disable handshake onto no-step-up', async () => {
    const victim = await registerLoginFull();
    await enrollTotp(victim.cookie);
    const attacker = await registerLoginFull();
    await enrollTotp(attacker.cookie);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, victim.account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, victim.cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    // Attacker replays the victim's disable handshake from their own session.
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: '000000', disable2FASessionId: initBody.disable2FASessionId },
      attacker.cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('reports too-many-attempts on 2FA disable when the account is locked out', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    // Exhaust the shared TOTP lockout via failed login-2FA attempts.
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
    }
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      {
        ke3,
        code: generateTotpCodeSync(secret),
        disable2FASessionId: initBody.disable2FASessionId,
      },
      cookie
    );
    expect(finish.status).toBe(429);
    const lockedBody = await finish.json<{ code: string }>();
    expect(lockedBody.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
  });

  it('returns the wrapped key by username as well as email', async () => {
    const account = await registerAccount();
    const res = await post('/auth/recovery/get-wrapped-key', { identifier: account.username });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
    });
  });

  it('dev-link returns a null token when none has been issued', async () => {
    // Registration always issues a token, so an account always has one; a
    // never-registered email is the "no token issued" case.
    const email = `${PREFIX}notoken${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const res = await get(`/auth/verify-email/dev-link?email=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null });
  });

  it('propagates a verification store failure on verify-email and dev-link', async () => {
    const failing: IdentityStores = {
      users: createIdentityStores(db).users,
      verification: {
        issueEmailVerification: () => errAsync(unavailableError('down')),
        issueVerificationDecoy: () => errAsync(unavailableError('down')),
        consumeEmailVerification: () => errAsync(unavailableError('down')),
        findUnverifiedByEmail: () => errAsync(unavailableError('down')),
        findLatestVerificationToken: () => errAsync(unavailableError('down')),
      },
    };
    const manifest = createIdentityManifest({ ...manifestDeps, stores: () => failing });
    const app = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    app.route(manifest.basePath, manifest.routes);
    const verify = await app.request(
      '/auth/verify-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: crypto.randomUUID() }),
      },
      testEnv
    );
    expect(verify.status).toBe(503);
    const devLink = await app.request(
      '/auth/verify-email/dev-link?email=someone@identity-routes.test',
      {},
      testEnv
    );
    expect(devLink.status).toBe(503);
  });
});

/**
 * The store-failure arm of every route whose users store is its only fallible
 * dependency. Each is reachable only by making that one read or write fail, so
 * the typed `unavailable` answer is otherwise untested at the route seam.
 */
describe('identity routes: user-store failures reach the wire', () => {
  function failingUsers(override: Partial<IdentityStores['users']>): IdentityRouteDeps['stores'] {
    return (database) => {
      const real = createIdentityStores(database);
      return { ...real, users: { ...real.users, ...override } };
    };
  }

  function appWithFailingUsers(override: Partial<IdentityStores['users']>): Hono<AppEnv> {
    return createApp({ ...manifestDeps, stores: failingUsers(override) });
  }

  it('propagates a user-store failure on billing token login', async () => {
    const account = await registerAccount();
    const issued = await issueBillingLoginToken({ redis, userId: account.userId });
    const app = appWithFailingUsers({ findById: () => errAsync(unavailableError('down')) });
    await expectStatus(
      post('/auth/token-login', { token: issued._unsafeUnwrap().token }, undefined, { app }),
      503
    );
  });

  it('propagates a user-store failure on a recovery-save init', async () => {
    const { cookie } = await registerLoginFull();
    const app = appWithFailingUsers({ findById: () => errAsync(unavailableError('down')) });
    await expectStatus(
      post('/auth/recovery/save/init', { ke1: [0, 0, 0, 0] }, cookie, { app }),
      503
    );
  });

  it('propagates a user-store failure on an acquisition-source read', async () => {
    const { cookie } = await registerLoginFull();
    const app = appWithFailingUsers({
      readAcquisitionSelfReport: () => errAsync(unavailableError('down')),
    });
    const res = await app.request(
      '/auth/account/acquisition-source',
      { headers: { cookie } },
      testEnv
    );
    expect(res.status).toBe(503);
  });

  it('propagates a user-store failure on an acquisition-source skip', async () => {
    const { cookie } = await registerLoginFull();
    const app = appWithFailingUsers({
      recordSelfReportSkip: () => errAsync(unavailableError('down')),
    });
    const res = await app.request(
      '/auth/account/acquisition-source',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ action: 'skip', context: 'post_signup' }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
  });
});

/**
 * The deletion executor's losing arm: another finish deleted the users row while
 * this one held its step-up, so the opening lock captures nothing. Only the
 * store can produce it — the route cannot be asked to race itself.
 */
describe('identity routes: account deletion finds the user already gone', () => {
  it('answers 404 when the deletion lock captures no row', async () => {
    const { account, cookie } = await registerLoginFull();
    const app = createApp({
      ...manifestDeps,
      stores: (database) => {
        const real = createIdentityStores(database);
        return {
          ...real,
          users: { ...real.users, lockForDeletionWithinTx: () => Promise.resolve(null) },
        };
      },
    });
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/account/delete/init', { ke1 }, cookie, { app });
    expect(init.status).toBe(200);
    const initBody = await init.json<{ ke2: number[]; deleteAccountSessionId: string }>();
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(initBody.ke2, client),
        deleteAccountSessionId: initBody.deleteAccountSessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        acknowledgedForfeitNanoUsd: centsToNanoUsd(WELCOME_CREDIT_CENTS),
      },
      cookie,
      { app }
    );

    expect(finish.status).toBe(404);
  });
});
