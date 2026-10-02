import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  startLogin as opaqueClientStartLogin,
} from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { BILLING_PORTAL_COOKIE_NAME, SESSION_COOKIE_NAME } from '../../lib/context/index.js';
import { IDENTITY_KEYS, loginNetworkLockoutKey } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/account/billing-portal.js';
import { callerIpIdForAddress } from '../../lib/redis/index.js';
import {
  ANOTHER_NETWORK,
  KEY_BLOBS,
  ONE_NETWORK,
  PREFIX,
  billingPortalCookieOf,
  billingPortalCredentialCookie,
  db,
  evictedUserIds,
  expectStatus,
  fullSessionCookie,
  get,
  login,
  loginInit,
  markVerified,
  post,
  redis,
  registerAccount,
  sessionCookieOf,
  testEnv,
  unsealBillingPortalCredential,
  unsealClaims,
} from './routes.integration.setup.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import type { LoginSuccessBody } from './routes.integration.setup.js';

/**
 * The Upstash REST transport carries each command as a name-first array inside
 * a pipeline body, so the command name is what identifies a delete. The opening
 * bracket keeps `getdel` — the pending handshake's own claim — out of the match.
 */
function isRedisDelete(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return typeof body === 'string' && body.includes('["del"');
}

describe('identity routes: login under a rotated KEK', () => {
  it('answers 500 INTERNAL, never AUTH_FAILED, when the row was sealed under a KEK this deployment does not hold', async () => {
    const account = await registerAccount();
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), account.password);
    const res = await post('/auth/login/init', { identifier: account.email, ke1 }, undefined, {
      env: { ...testEnv, OPAQUE_KEK: 'rotated-kek-at-least-32-characters-long!!' }, // gitleaks:allow
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: ERROR_CODES.INTERNAL });
  });
});

describe('identity routes: login', () => {
  it('completes the OPAQUE register→login round trip with the real crypto stack', async () => {
    const account = await registerAccount();
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    const body = await res.json<LoginSuccessBody>();
    expect(body).toEqual({
      success: true,
      userId: account.userId,
      email: account.email,
      passwordWrappedPrivateKey: KEY_BLOBS.passwordWrappedPrivateKey,
    });
    const cookie = sessionCookieOf(res);
    const probe = await get('/t/session', cookie);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ kind: 'full' });
  });

  it('logs in by username as well as email', async () => {
    const account = await registerAccount();
    const res = await login(account.username, account.password);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with the typed auth failure', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, `wrong ${account.password}`, client);
    // A wrong password fails the client side of the AKE, so no honest KE3
    // exists; a stale KE3 from a different handshake exercises the server's
    // MAC verification failure path.
    const other = await registerAccount();
    const otherClient = createOpaqueClient();
    const { body: otherInit } = await loginInit(other.email, other.password, otherClient);
    const { ke3 } = await opaqueClientFinishLogin(
      otherClient,
      otherInit.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/login/finish', {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('answers an unknown identifier with the same shape as a wrong password (enumeration safety)', async () => {
    const ghost = `${PREFIX}ghost@identity-routes.test`;
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, ghost));
    expect(rows).toHaveLength(0);

    const { res: initRes, body } = await loginInit(ghost, 'any password at all');
    expect(initRes.status).toBe(200);
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'ke2',
      'loginSessionId',
    ]);
    expect(body.ke2.length).toBeGreaterThan(0);

    const finishRes = await post('/auth/login/finish', {
      identifier: ghost,
      ke3: [0, 1, 2],
      loginSessionId: body.loginSessionId,
    });
    expect(finishRes.status).toBe(401);
    expect(await finishRes.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('refuses a locked account with the typed error even with the correct password', async () => {
    const account = await registerAccount();
    await db
      .update(users)
      .set({ lockedAt: new Date(), lockReason: 'admin' })
      .where(eq(users.id, account.userId));
    const res = await login(account.email, account.password);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ACCOUNT_LOCKED });
  });

  it('rejects a replayed login handshake (pending state is single-use)', async () => {
    const account = await registerAccount();
    await markVerified(account.email);
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const finishBody = {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    };
    await expectStatus(post('/auth/login/finish', finishBody), 200);
    const replay = await post('/auth/login/finish', finishBody);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_LOGIN });
  });

  it('mints exactly one session when two finish deliveries race the same handshake', async () => {
    const account = await registerAccount();
    await markVerified(account.email);
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const finishBody = { identifier: account.email, ke3, loginSessionId: body.loginSessionId };
    const [first, second] = await Promise.all([
      post('/auth/login/finish', finishBody),
      post('/auth/login/finish', finishBody),
    ]);
    const statuses = [first.status, second.status].toSorted((a, b) => a - b);
    // The atomic consume gives the handshake to one delivery; the loser sees
    // no pending state and restarts — never a second minted session.
    expect(statuses).toEqual([200, 400]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    expect(winner.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(loser.headers.get('set-cookie')).toBeNull();
    expect(await loser.json()).toEqual({ code: ERROR_CODES.NO_PENDING_LOGIN });
  });

  it('rejects a finish whose identifier does not match the pending handshake', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const res = await post('/auth/login/finish', {
      identifier: `other-${account.email}`,
      ke3,
      loginSessionId: body.loginSessionId,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('bounds the pending login state with the registry TTL', async () => {
    const account = await registerAccount();
    const { body } = await loginInit(account.email, account.password);
    const ttl = await redis.ttl(IDENTITY_KEYS.opaquePendingLogin.buildKey(body.loginSessionId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDENTITY_KEYS.opaquePendingLogin.ttlSeconds);
  });

  it('locks out login from one address at the per-network cap with a TTL-derived retry-after', async () => {
    const ghost = `${PREFIX}lim${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.loginLockoutPerNetwork;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { res } = await loginInit(ghost, 'any password at all', undefined, ONE_NETWORK);
      expect(res.status).toBe(200);
    }
    const { res, body } = await loginInit(ghost, 'any password at all', undefined, ONE_NETWORK);
    expect(res.status).toBe(429);
    const denied = body as unknown as { code: string; details: { retryAfterSeconds: number } };
    expect(denied.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(denied.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });

  it('reserves login attempts on init and clears the counter on a verified login', async () => {
    const account = await registerAccount();
    const counterKey = rateLimitKey(IDENTITY_KEYS.loginLockout, account.userId)._unsafeUnwrap();
    await loginInit(account.email, 'wrong password entirely');
    await loginInit(account.email, 'wrong password entirely');
    expect(await redis.get(counterKey)).toBe(2);
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    expect(await redis.get(counterKey)).toBeNull();
  });

  it('issues the session when the lockout clear fails, a password already verified', async () => {
    const account = await registerAccount();
    const counterKey = rateLimitKey(IDENTITY_KEYS.loginLockout, account.userId)._unsafeUnwrap();
    await loginInit(account.email, 'wrong password entirely');
    const realFetch = globalThis.fetch;
    // The counter clear is a DEL over the REST transport, so the transport is
    // where one is made to fail without disturbing the reads and writes the
    // handshake itself needs.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) =>
        isRedisDelete(init)
          ? Promise.reject(new Error('redis del refused'))
          : realFetch(input, init)
      );

    try {
      const res = await login(account.email, account.password);

      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toContain(SESSION_COOKIE_NAME);
    } finally {
      fetchSpy.mockRestore();
    }
    // The surviving counter is what proves the clear genuinely failed rather
    // than the transport never carrying one — and it is the safe direction: a
    // lockout stays in force rather than being wrongly lifted.
    expect(await redis.get(counterKey)).not.toBeNull();
  });

  it('leaves another address able to log in after one address exhausts its window', async () => {
    const ghost = `${PREFIX}net${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.loginLockoutPerNetwork;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { res } = await loginInit(ghost, 'any password at all', undefined, ONE_NETWORK);
      expect(res.status).toBe(200);
    }

    const refused = await loginInit(ghost, 'any password at all', undefined, ONE_NETWORK);
    const elsewhere = await loginInit(ghost, 'any password at all', undefined, ANOTHER_NETWORK);

    expect(refused.res.status).toBe(429);
    expect(elsewhere.res.status).toBe(200);
  });

  it('leaves the account-wide counter unspent by the request its own window refused', async () => {
    const ghost = `${PREFIX}aon${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.loginLockoutPerNetwork;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await loginInit(ghost, 'any password at all', undefined, ONE_NETWORK);
    }
    const refused = await loginInit(ghost, 'any password at all', undefined, ONE_NETWORK);
    expect(refused.res.status).toBe(429);

    // All-or-nothing: the refusing layer advances past its cap, every other
    // layer is left alone, so the ceiling stands at what the ADMITTED attempts
    // spent.
    expect(
      await redis.get(rateLimitKey(IDENTITY_KEYS.loginLockout, ghost.toLowerCase())._unsafeUnwrap())
    ).toBe(maxAttempts);
  });

  it('admits exactly the per-network cap under concurrent inits from one address', async () => {
    // What refuses a burst from one address is the per-network window, not the
    // account-wide ceiling, which this burst leaves far from its cap. The
    // atomicity being proved is the same; the window it is proved on is not.
    const ghost = `${PREFIX}race${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.loginLockoutPerNetwork;
    const overshoot = 3;
    const results = await Promise.all(
      Array.from({ length: maxAttempts + overshoot }, () =>
        loginInit(ghost, 'any password at all', undefined, ONE_NETWORK)
      )
    );
    const statuses = results.map(({ res }) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('admits exactly the attempts the account-wide window still owes, under concurrency', async () => {
    const ghost = `${PREFIX}ceil${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.loginLockout;
    const headroom = 3;
    const overshoot = 3;
    const attempts = headroom + overshoot;
    // The window is seeded to its last few attempts so the burst races that
    // headroom rather than the whole cap. The property under test is that
    // exactly the attempts still owing are admitted when they arrive at once,
    // and a cap-sized burst of cold handshakes proves no more of it: it spends
    // one bounded Redis round trip and one OPAQUE handshake per attempt, and a
    // single check that outruns its bound answers a fail-closed 503 that is
    // neither of the statuses counted below.
    await redis.set(
      rateLimitKey(IDENTITY_KEYS.loginLockout, ghost.toLowerCase())._unsafeUnwrap(),
      maxAttempts - headroom,
      { ex: windowSeconds }
    );
    // Spread wide enough that no address reaches its own window, so the ceiling
    // is the only layer that can refuse.
    const networks = Math.ceil(attempts / IDENTITY_KEYS.loginLockoutPerNetwork.maxAttempts);
    const results = await Promise.all(
      Array.from({ length: attempts }, (_unused, index) =>
        loginInit(ghost, 'any password at all', undefined, `203.0.113.${String(index % networks)}`)
      )
    );
    const statuses = results.map(({ res }) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(headroom);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('clears the network window this caller spent on a verified login', async () => {
    const account = await registerAccount();
    await loginInit(account.email, 'wrong password entirely', undefined, ONE_NETWORK);
    const networkKey = await loginNetworkLockoutKey(
      account.userId,
      await callerIpIdForAddress(ONE_NETWORK)
    );
    expect(await redis.get(networkKey)).toBe(1);

    const res = await login(account.email, account.password, ONE_NETWORK);

    expect(res.status).toBe(200);
    expect(await redis.get(networkKey)).toBeNull();
  });

  it('issues a pending-2fa session for a TOTP-enabled user', async () => {
    const account = await registerAccount();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requires2FA: true, userId: account.userId });

    const cookie = sessionCookieOf(res);
    const pendingProbe = await get('/t/pending', cookie);
    expect(pendingProbe.status).toBe(200);
    expect(await pendingProbe.json()).toEqual({ kind: 'pending-2fa' });
    await expectStatus(get('/t/session', cookie), 403);
    await expectStatus(get('/t/billing', cookie), 403);
  });
});

describe('identity routes: logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await fullSessionCookie();
    const claims = await unsealClaims(cookie);
    await expectStatus(get('/t/session', cookie), 200);
    const res = await post('/auth/logout', {}, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    await expectStatus(get('/t/session', cookie), 401);
    // The revoke threads the eviction port through (ARCHITECTURE §Streaming & realtime).
    expect(evictedUserIds).toContain(claims.userId);
  });

  it('succeeds without any session (naturally idempotent)', async () => {
    const res = await post('/auth/logout', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('succeeds when repeated with an already-revoked cookie', async () => {
    const cookie = await fullSessionCookie();
    await expectStatus(post('/auth/logout', {}, cookie), 200);
    const repeat = await post('/auth/logout', {}, cookie);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ success: true });
  });
});

describe('identity routes: billing-portal credential lifecycle', () => {
  it('reaches billing-token routes but no full-session surface', async () => {
    const cookie = await billingPortalCredentialCookie();
    const billing = await get('/t/billing', cookie);
    expect(billing.status).toBe(200);
    expect(await billing.json()).toEqual({ kind: 'billing-portal' });
    // Forbidden, not unauthorized, on both: the authorizer refuses the kind
    // outright rather than admitting it to a route that then rejects it.
    await expectStatus(get('/t/session', cookie), 403);
    await expectStatus(get('/t/pending', cookie), 403);
  });
});

describe('identity routes: billing-portal token login', () => {
  async function issuedToken(): Promise<{ token: string; userId: string }> {
    const account = await registerAccount();
    const issued = await issueBillingLoginToken({ redis, userId: account.userId });
    return { token: issued._unsafeUnwrap().token, userId: account.userId };
  }

  it('sets only the path-scoped billing cookie, never a login session', async () => {
    const { token, userId } = await issuedToken();
    const res = await post('/auth/token-login', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).not.toContain(`${SESSION_COOKIE_NAME}=`);
    // The attributes are asserted whole rather than sampled: the path scope is
    // what keeps the credential off every route outside the billing surface,
    // and a silently dropped attribute would widen its delivery.
    const [nameValue, ...attributes] = header.split('; ');
    expect(nameValue?.split('=')[0]).toBe(BILLING_PORTAL_COOKIE_NAME);
    expect(attributes).toEqual(['Max-Age=3600', 'Path=/billing', 'HttpOnly', 'SameSite=Lax']);
    const credential = await unsealBillingPortalCredential(billingPortalCookieOf(res));
    expect(credential.userId).toBe(userId);
    expect(credential.credentialKind).toBe('billing-portal');
  });

  it('admits the minted credential to billing-token routes and nothing session-class', async () => {
    const { token } = await issuedToken();
    const cookie = billingPortalCookieOf(await post('/auth/token-login', { token }));
    const billing = await get('/t/billing', cookie);
    expect(billing.status).toBe(200);
    expect(await billing.json()).toEqual({ kind: 'billing-portal' });
    await expectStatus(get('/t/session', cookie), 403);
  });

  it('replays the same token onto the same credential with no second side effect', async () => {
    const { token } = await issuedToken();
    const first = await post('/auth/token-login', { token });
    const second = await post('/auth/token-login', { token });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstCredential = await unsealBillingPortalCredential(billingPortalCookieOf(first));
    const secondCredential = await unsealBillingPortalCredential(billingPortalCookieOf(second));
    expect(secondCredential.sessionId).toBe(firstCredential.sessionId);
  });

  it('answers unknown, deleted-user, and locked-account tokens with one uniform refusal', async () => {
    const unknown = await post('/auth/token-login', { token: crypto.randomUUID() });
    expect(unknown.status).toBe(401);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ code: ERROR_CODES.LOGIN_TOKEN_INVALID });
    const { token, userId } = await issuedToken();
    await db.delete(users).where(eq(users.id, userId));
    const orphaned = await post('/auth/token-login', { token });
    expect(orphaned.status).toBe(401);
    expect(await orphaned.json()).toEqual(unknownBody);
    const locked = await issuedToken();
    await db
      .update(users)
      .set({ lockedAt: new Date(), lockReason: 'admin' })
      .where(eq(users.id, locked.userId));
    const refusedLocked = await post('/auth/token-login', { token: locked.token });
    expect(refusedLocked.status).toBe(401);
    expect(await refusedLocked.json()).toEqual(unknownBody);
  });

  it('rejects a malformed token body as validation input', async () => {
    const res = await post('/auth/token-login', { token: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('requires no Idempotency-Key header (the token is the key)', async () => {
    const { token } = await issuedToken();
    // `post` sends no Idempotency-Key; a 200 proves the token-is-key
    // exemption is declared on the route.
    await expectStatus(post('/auth/token-login', { token }), 200);
  });
});
