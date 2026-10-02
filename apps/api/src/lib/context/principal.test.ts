import { describe, it, expect, afterEach, vi } from 'vitest';
import { getIronSession } from 'iron-session';
import { DAY_MS, TEST_DAY_START, freezeClock, setClock } from '@hushbox/shared/test-time';
import {
  BILLING_PORTAL_COOKIE_NAME,
  BILLING_PORTAL_COOKIE_PATH,
  BILLING_PORTAL_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  billingPortalCookieOptions,
  parseBillingPortalClaims,
  parseSessionClaims,
  derivePrincipal,
  sessionCookieOptions,
} from './principal.js';
import type { BillingPortalClaims, SessionClaims } from './principal.js';
import type { SessionOptions } from 'iron-session';

const NOW = TEST_DAY_START;
const SECRET = 'secret-at-least-32-characters-long!!';

function validClaims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    createdAt: NOW - 1000,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    ...overrides,
  };
}

describe('parseSessionClaims', () => {
  it('returns claims for a valid session object', () => {
    expect(parseSessionClaims(validClaims())).toEqual(validClaims());
  });

  it('strips unknown fields sealed by the legacy session writer', () => {
    const legacyShaped = {
      ...validClaims(),
      email: 'a@b.c',
      username: 'alice',
      emailVerified: true,
      totpEnabled: false,
      hasAcknowledgedPhrase: true,
    };
    expect(parseSessionClaims(legacyShaped)).toEqual(validClaims());
  });

  it('refuses a legacy billing-flagged payload instead of widening it to a login session', () => {
    expect(parseSessionClaims({ ...validClaims(), billingOnly: true })).toBeNull();
  });

  it('refuses a billing-portal payload', () => {
    expect(parseSessionClaims({ ...validClaims(), credentialKind: 'billing-portal' })).toBeNull();
  });

  it('returns null for a non-object value', () => {
    expect(parseSessionClaims('not-a-session')).toBeNull();
  });

  it('returns null when userId is missing', () => {
    const incomplete: Record<string, unknown> = { ...validClaims() };
    delete incomplete['userId'];
    expect(parseSessionClaims(incomplete)).toBeNull();
  });

  it('returns null when userId is empty', () => {
    expect(parseSessionClaims(validClaims({ userId: '' }))).toBeNull();
  });

  it('returns null when pending2FA is not a boolean', () => {
    expect(parseSessionClaims({ ...validClaims(), pending2FA: 'yes' })).toBeNull();
  });
});

function validBillingPortalClaims(
  overrides: Partial<BillingPortalClaims> = {}
): BillingPortalClaims {
  return {
    credentialKind: 'billing-portal',
    userId: 'user-1',
    sessionId: 'session-1',
    createdAt: NOW - 1000,
    ...overrides,
  };
}

describe('parseBillingPortalClaims', () => {
  it('returns the credential for a valid billing-portal payload', () => {
    expect(parseBillingPortalClaims(validBillingPortalClaims())).toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('refuses a login payload', () => {
    expect(parseBillingPortalClaims(validClaims())).toBeNull();
  });

  it('refuses a payload whose discriminator names another credential', () => {
    expect(
      parseBillingPortalClaims({ ...validBillingPortalClaims(), credentialKind: 'session' })
    ).toBeNull();
  });
});

describe('derivePrincipal', () => {
  it('returns none when no claims exist', () => {
    expect(derivePrincipal(null, NOW)).toEqual({ kind: 'none' });
  });

  it('returns full for a valid non-pending session', () => {
    const claims = validClaims();
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'full', claims });
  });

  it('returns pending-2fa for an unexpired mid-2FA session', () => {
    const claims = validClaims({ pending2FA: true, pending2FAExpiresAt: NOW + 60_000 });
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'pending-2fa', claims });
  });

  it('returns none for an expired mid-2FA session', () => {
    const claims = validClaims({ pending2FA: true, pending2FAExpiresAt: NOW - 1 });
    expect(derivePrincipal(claims, NOW)).toEqual({ kind: 'none' });
  });

  it('never derives link-guest from cookie claims (link credentials ride outside the session)', () => {
    const shapes = [
      null,
      validClaims(),
      validClaims({ pending2FA: true, pending2FAExpiresAt: NOW + 60_000 }),
      validClaims({ pending2FA: true, pending2FAExpiresAt: NOW - 1 }),
    ];
    for (const claims of shapes) {
      expect(derivePrincipal(claims, NOW).kind).not.toBe('link-guest');
    }
  });

  it('never derives a billing-portal principal from login claims', () => {
    const shapes = [
      validClaims(),
      validClaims({ pending2FA: true, pending2FAExpiresAt: NOW + 60_000 }),
      validClaims({ pending2FA: true, pending2FAExpiresAt: NOW - 1 }),
    ];
    for (const claims of shapes) {
      expect(derivePrincipal(claims, NOW).kind).not.toBe('billing-portal');
    }
  });
});

describe('sessionCookieOptions', () => {
  it('keeps the pre-rewrite cookie name and 30-day max age', () => {
    expect(SESSION_COOKIE_NAME).toBe('hushbox_session');
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30);
  });

  it('builds hardened production cookie options', () => {
    expect(sessionCookieOptions(SECRET, true)).toEqual({
      password: SECRET,
      cookieName: SESSION_COOKIE_NAME,
      ttl: SESSION_MAX_AGE_SECONDS,
      cookieOptions: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: SESSION_MAX_AGE_SECONDS,
      },
    });
  });

  it('relaxes secure and sameSite outside production (local http dev)', () => {
    const options = sessionCookieOptions(SECRET, false);
    expect(options.cookieOptions).toMatchObject({ secure: false, sameSite: 'lax' });
  });
});

describe('billingPortalCookieOptions', () => {
  it('carries its own cookie name, never the login session’s', () => {
    expect(BILLING_PORTAL_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
  });

  it('scopes the credential to the billing path with a one-hour lifetime', () => {
    expect(BILLING_PORTAL_COOKIE_PATH).toBe('/billing');
    expect(BILLING_PORTAL_MAX_AGE_SECONDS).toBe(60 * 60);
    expect(billingPortalCookieOptions(SECRET, true)).toEqual({
      password: SECRET,
      cookieName: BILLING_PORTAL_COOKIE_NAME,
      ttl: BILLING_PORTAL_MAX_AGE_SECONDS,
      cookieOptions: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: BILLING_PORTAL_MAX_AGE_SECONDS,
        path: BILLING_PORTAL_COOKIE_PATH,
      },
    });
  });

  it('relaxes secure and sameSite outside production (local http dev)', () => {
    expect(billingPortalCookieOptions(SECRET, false).cookieOptions).toMatchObject({
      secure: false,
      sameSite: 'lax',
    });
  });
});

describe('session seal lifetime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function sealSession(options: SessionOptions): Promise<string> {
    const response = new Response();
    const session = await getIronSession<SessionClaims>(
      new Request('https://api.test/'),
      response,
      options
    );
    Object.assign(session, validClaims());
    await session.save();
    const setCookie = response.headers.get('set-cookie');
    if (setCookie === null) throw new Error('session.save() set no cookie');
    return setCookie.split(';')[0] ?? '';
  }

  async function unsealSession(cookie: string, options: SessionOptions): Promise<unknown> {
    return getIronSession(
      new Request('https://api.test/', { headers: { cookie } }),
      new Response(),
      options
    );
  }

  it('still unseals past 14 days while the cookie is within its max age', async () => {
    const options = sessionCookieOptions(SECRET, true);
    freezeClock(NOW);
    const cookie = await sealSession(options);

    setClock(NOW + 20 * DAY_MS);
    expect(parseSessionClaims(await unsealSession(cookie, options))).toEqual(validClaims());
  });

  it('no longer unseals once the cookie max age has elapsed', async () => {
    const options = sessionCookieOptions(SECRET, true);
    freezeClock(NOW);
    const cookie = await sealSession(options);

    setClock(NOW + 31 * DAY_MS);
    expect(parseSessionClaims(await unsealSession(cookie, options))).toBeNull();
  });
});
