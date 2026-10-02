import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { generateTotpCodeSync } from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/account/billing-portal.js';
import {
  billingPortalCookieOf,
  db,
  enrollTotp,
  evictedUserIds,
  expectStatus,
  get,
  login,
  post,
  recordCaptures,
  recordErrorLines,
  redis,
  registerAccount,
  registerLoginFull,
  scrubbedCaptureTags,
  sessionCookieOf,
  testEnv,
  wrongCode,
} from './routes.integration.setup.js';

describe('identity routes: TOTP enrollment and login 2FA', () => {
  it('enrolls TOTP, then promotes a pending-2fa login to full via a valid code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const [row] = await db
      .select({ totpEnabled: users.totpEnabled, secret: users.totpSecretEncrypted })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.totpEnabled).toBe(true);
    expect(row?.secret).not.toBeNull();

    const loginRes = await login(account.email, account.password);
    expect(await loginRes.json()).toEqual({ requires2FA: true, userId: account.userId });
    const pendingCookie = sessionCookieOf(loginRes);

    const verify = await post(
      '/auth/login/2fa/verify',
      { code: generateTotpCodeSync(secret) },
      pendingCookie
    );
    expect(verify.status).toBe(200);
    const body = await verify.json<{ success: boolean; userId: string }>();
    expect(body.success).toBe(true);
    const fullCookie = sessionCookieOf(verify);
    const probe = await get('/t/session', fullCookie);
    expect(await probe.json()).toEqual({ kind: 'full' });
    // The pending-2fa → full rotation revokes through the eviction port.
    expect(evictedUserIds).toContain(account.userId);
  });

  it('answers the typed stranded error at login 2FA when the stored secret is under a foreign TOTP key', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post(
      '/auth/login/2fa/verify',
      { code: generateTotpCodeSync(secret) },
      pendingCookie,
      { env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' } } // gitleaks:allow
    );
    expect(verify.status).toBe(500);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.TOTP_SECRET_STRANDED });
  });

  it('pages the operator once under the stranded fingerprint at login 2FA, answering the same typed error', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const pendingCookie = sessionCookieOf(await login(account.email, account.password));
    const { response, lines } = await recordErrorLines(() =>
      post('/auth/login/2fa/verify', { code: generateTotpCodeSync(secret) }, pendingCookie, {
        env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' }, // gitleaks:allow
      })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: ERROR_CODES.TOTP_SECRET_STRANDED });
    expect(
      lines.filter((line) => line.msg === 'error.captured').map((line) => line.errorCode)
    ).toEqual(['totp_secret_stranded']);
    expect(lines).toContainEqual(
      expect.objectContaining({
        errorCode: 'totp_secret_stranded',
        userId: account.userId,
        route: '/auth/login/2fa/verify',
      })
    );
  });

  it('carries only allowlisted fields on the stranded page, never the sealed blob', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const pendingCookie = sessionCookieOf(await login(account.email, account.password));
    const [row] = await db
      .select({ secret: users.totpSecretEncrypted })
      .from(users)
      .where(eq(users.id, account.userId));
    const { lines } = await recordErrorLines(() =>
      post('/auth/login/2fa/verify', { code: generateTotpCodeSync(secret) }, pendingCookie, {
        env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' }, // gitleaks:allow
      })
    );
    const stranded = lines.filter((line) => line.errorCode === 'totp_secret_stranded');
    expect(stranded).toHaveLength(2);
    for (const line of stranded) {
      expect(
        Object.keys(line).every((key) =>
          ['level', 'msg', 'errorCode', 'errorName', 'stack', 'userId', 'route'].includes(key)
        )
      ).toBe(true);
      expect(JSON.stringify(line)).not.toContain(row?.secret);
    }
  });

  it('names the stranded user and the gate on the event that leaves the process, and nothing else', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const pendingCookie = sessionCookieOf(await login(account.email, account.password));
    const { response, captures } = await recordCaptures((app) =>
      post('/auth/login/2fa/verify', { code: generateTotpCodeSync(secret) }, pendingCookie, {
        app,
        env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' }, // gitleaks:allow
      })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: ERROR_CODES.TOTP_SECRET_STRANDED });
    expect(captures).toHaveLength(1);
    const captured = captures[0]?.error ?? new Error('nothing captured');
    // The whole key set, not a lookup of the two expected: what this guards
    // against is a THIRD property arriving on the error — an email, a
    // username, a sealed blob — where the scrub's allowlist would be the only
    // thing standing between it and the wire.
    expect(Object.keys(captured)).toEqual(['totpStrandedUserId', 'totpStrandedRoute']);
    expect(Reflect.get(captured, 'totpStrandedUserId')).toBe(account.userId);
    expect(Reflect.get(captured, 'totpStrandedRoute')).toBe('/auth/login/2fa/verify');
    // End to end through the gate that decides what reaches Sentry: the
    // retained channel carries the id and the route, so the operator can run
    // the per-user repair, and carries no other tag.
    expect(scrubbedCaptureTags(captures)).toEqual({
      errorCode: 'totp_secret_stranded',
      totpStrandedUserId: account.userId,
      totpStrandedRoute: '/auth/login/2fa/verify',
    });
  });

  it('captures nothing when the login-2FA code verifies', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const pendingCookie = sessionCookieOf(await login(account.email, account.password));
    const { response, lines } = await recordErrorLines(() =>
      post('/auth/login/2fa/verify', { code: generateTotpCodeSync(secret) }, pendingCookie)
    );
    expect(response.status).toBe(200);
    expect(lines.filter((line) => line.msg === 'error.captured')).toEqual([]);
  });

  it('captures nothing when a login-2FA code is replayed', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const code = generateTotpCodeSync(secret);
    const first = sessionCookieOf(await login(account.email, account.password));
    const accepted = await post('/auth/login/2fa/verify', { code }, first);
    expect(accepted.status).toBe(200);
    const second = sessionCookieOf(await login(account.email, account.password));
    const { response, lines } = await recordErrorLines(() =>
      post('/auth/login/2fa/verify', { code }, second)
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
    expect(lines.filter((line) => line.msg === 'error.captured')).toEqual([]);
  });

  it('rejects a wrong code at login 2FA with the typed invalid-code error', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('rejects a wrong code during enrollment confirmation', async () => {
    const { cookie } = await registerLoginFull();
    const setup = await post('/auth/2fa/setup', {}, cookie);
    const { secret } = await setup.json<{ secret: string }>();
    const verify = await post('/auth/2fa/verify', { code: wrongCode(secret) }, cookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('refuses setup when TOTP is already enabled', async () => {
    const { cookie } = await registerLoginFull();
    await enrollTotp(cookie);
    const setup = await post('/auth/2fa/setup', {}, cookie);
    expect(setup.status).toBe(400);
    expect(await setup.json()).toEqual({ code: ERROR_CODES.TOTP_ALREADY_ENABLED });
  });

  it('rejects a verify with no pending setup', async () => {
    const { cookie } = await registerLoginFull();
    const verify = await post('/auth/2fa/verify', { code: '000000' }, cookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.NO_PENDING_2FA_SETUP });
  });

  it('requires an authenticated session to set up TOTP', async () => {
    await expectStatus(post('/auth/2fa/setup', {}), 401);
  });
});

describe('identity routes: TOTP-verify lockout', () => {
  it('locks out after the registry number of failed login-2FA attempts', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
      expect(res.status).toBe(400);
    }
    const locked = await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
    expect(locked.status).toBe(429);
    const body = await locked.json<{ code: string; details: { retryAfterSeconds: number } }>();
    expect(body.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('verifies at most the cap even under concurrent distinct wrong codes', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout;
    const live = generateTotpCodeSync(secret);
    const codes = Array.from({ length: maxAttempts + 6 }, (_, n) =>
      String(n).padStart(6, '0')
    ).filter((code) => code !== live);
    const results = await Promise.all(
      codes
        .slice(0, maxAttempts + 5)
        .map((code) => post('/auth/login/2fa/verify', { code }, pendingCookie))
    );
    const statuses = results.map((res) => res.status);
    // The atomic attempt reservation bounds VERIFICATIONS, not just recorded
    // failures: exactly maxAttempts submissions reach the verifier (invalid),
    // the rest are gated before any crypto runs.
    expect(statuses.filter((status) => status === 400)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});

describe('identity routes: login 2FA verify principal gate', () => {
  it('refuses the billing-portal credential at the authorizer, never in the handler', async () => {
    const account = await registerAccount();
    const issued = await issueBillingLoginToken({ redis, userId: account.userId });
    const login = await post('/auth/token-login', { token: issued._unsafeUnwrap().token });
    const cookie = billingPortalCookieOf(login);
    const res = await post('/auth/login/2fa/verify', { code: '123456' }, cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses a full session gracefully instead of throwing', async () => {
    const { cookie } = await registerLoginFull();
    const res = await post('/auth/login/2fa/verify', { code: '123456' }, cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('refuses an anonymous caller gracefully instead of throwing', async () => {
    const res = await post('/auth/login/2fa/verify', { code: '123456' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});
