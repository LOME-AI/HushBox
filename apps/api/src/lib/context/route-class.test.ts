import { describe, it, expect } from 'vitest';
import { STATUS_BY_DOMAIN_CODE } from './domain-error-status.js';
import { ROUTE_CLASSES, authorizeAccess } from './route-class.js';
import type { BillingPortalClaims, Principal, SessionClaims } from './principal.js';

const claims: SessionClaims = {
  userId: 'user-1',
  sessionId: 'session-1',
  createdAt: 0,
  pending2FA: false,
  pending2FAExpiresAt: 0,
};

const credential: BillingPortalClaims = {
  credentialKind: 'billing-portal',
  userId: 'user-1',
  sessionId: 'session-1',
  createdAt: 0,
};

const none: Principal = { kind: 'none' };
const pending: Principal = { kind: 'pending-2fa', claims };
const billingPortal: Principal = { kind: 'billing-portal', credential };
const full: Principal = { kind: 'full', claims };
const linkGuest: Principal = { kind: 'link-guest', linkId: 'link-1', conversationId: 'conv-1' };
const adminActor: Principal = {
  kind: 'admin-actor',
  email: 'admin@hushbox.test',
  audience: 'access-aud',
  role: 'operator',
};

const DEV = { isProduction: false };
const PROD = { isProduction: true };

// Which code each (class, principal) pair yields is this file's subject; the
// code→status pairing is pinned once, at the map's own test.
const ALLOWED = { allowed: true };
const UNAUTHORIZED = {
  allowed: false,
  status: STATUS_BY_DOMAIN_CODE.unauthorized,
  code: 'unauthorized',
};
const FORBIDDEN = { allowed: false, status: STATUS_BY_DOMAIN_CODE.forbidden, code: 'forbidden' };
const NOT_FOUND = { allowed: false, status: STATUS_BY_DOMAIN_CODE.not_found, code: 'not_found' };

describe('ROUTE_CLASSES', () => {
  it('is the closed six-class union', () => {
    expect(ROUTE_CLASSES).toEqual([
      'public',
      'session',
      'pending-2fa',
      'billing-token',
      'dev-only',
      'admin',
    ]);
  });
});

describe('authorizeAccess: default-deny', () => {
  it('denies an undeclared route class for an anonymous caller', () => {
    expect(authorizeAccess(undefined, none, DEV)).toEqual(FORBIDDEN);
  });

  it('denies an undeclared route class even for a full session', () => {
    expect(authorizeAccess(undefined, full, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: public', () => {
  it('allows an anonymous caller', () => {
    expect(authorizeAccess('public', none, DEV)).toEqual(ALLOWED);
  });

  it('allows a pending-2FA session', () => {
    expect(authorizeAccess('public', pending, DEV)).toEqual(ALLOWED);
  });

  it('allows a full session', () => {
    expect(authorizeAccess('public', full, PROD)).toEqual(ALLOWED);
  });
});

describe('authorizeAccess: session', () => {
  it('allows a full session', () => {
    expect(authorizeAccess('session', full, DEV)).toEqual(ALLOWED);
  });

  it('rejects an anonymous caller as unauthorized', () => {
    expect(authorizeAccess('session', none, DEV)).toEqual(UNAUTHORIZED);
  });

  it('rejects a pending-2FA session as forbidden', () => {
    expect(authorizeAccess('session', pending, DEV)).toEqual(FORBIDDEN);
  });

  it('rejects the billing-portal credential as forbidden', () => {
    expect(authorizeAccess('session', billingPortal, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: pending-2fa', () => {
  it('allows a pending-2FA session', () => {
    expect(authorizeAccess('pending-2fa', pending, DEV)).toEqual(ALLOWED);
  });

  it('allows an anonymous caller (login entry points carry this class)', () => {
    expect(authorizeAccess('pending-2fa', none, DEV)).toEqual(ALLOWED);
  });

  it('allows a full session', () => {
    expect(authorizeAccess('pending-2fa', full, DEV)).toEqual(ALLOWED);
  });

  it('rejects the billing-portal credential as forbidden', () => {
    expect(authorizeAccess('pending-2fa', billingPortal, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: billing-token', () => {
  it('allows the billing-portal credential', () => {
    expect(authorizeAccess('billing-token', billingPortal, DEV)).toEqual(ALLOWED);
  });

  it('allows a full session', () => {
    expect(authorizeAccess('billing-token', full, DEV)).toEqual(ALLOWED);
  });

  it('rejects an anonymous caller as unauthorized', () => {
    expect(authorizeAccess('billing-token', none, DEV)).toEqual(UNAUTHORIZED);
  });

  it('rejects a pending-2FA session as forbidden', () => {
    expect(authorizeAccess('billing-token', pending, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: link-guest reaches no HTTP route class', () => {
  it('is denied on every declared route class, in and out of production', () => {
    for (const routeClass of ROUTE_CLASSES) {
      expect(authorizeAccess(routeClass, linkGuest, DEV)).toEqual(FORBIDDEN);
      expect(authorizeAccess(routeClass, linkGuest, PROD)).toEqual(FORBIDDEN);
    }
  });

  it('is denied on an undeclared route class', () => {
    expect(authorizeAccess(undefined, linkGuest, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: trial-session reaches no HTTP route class', () => {
  const trialSession: Principal = { kind: 'trial-session', sessionId: 'session-1' };

  it('is denied on every declared route class, in and out of production', () => {
    for (const routeClass of ROUTE_CLASSES) {
      expect(authorizeAccess(routeClass, trialSession, DEV)).toEqual(FORBIDDEN);
      expect(authorizeAccess(routeClass, trialSession, PROD)).toEqual(FORBIDDEN);
    }
  });

  it('is denied on an undeclared route class', () => {
    expect(authorizeAccess(undefined, trialSession, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: billing-portal reaches ONLY the billing-token class', () => {
  it('is denied on every other declared route class, public included', () => {
    for (const routeClass of ROUTE_CLASSES) {
      if (routeClass === 'billing-token') continue;
      expect(authorizeAccess(routeClass, billingPortal, DEV)).toEqual(FORBIDDEN);
      expect(authorizeAccess(routeClass, billingPortal, PROD)).toEqual(FORBIDDEN);
    }
  });

  it('is denied on an undeclared route class', () => {
    expect(authorizeAccess(undefined, billingPortal, DEV)).toEqual(FORBIDDEN);
  });

  it('is allowed on billing-token in and out of production', () => {
    expect(authorizeAccess('billing-token', billingPortal, DEV)).toEqual(ALLOWED);
    expect(authorizeAccess('billing-token', billingPortal, PROD)).toEqual(ALLOWED);
  });
});

describe('authorizeAccess: admin', () => {
  it('allows the admin-actor principal, in and out of production', () => {
    expect(authorizeAccess('admin', adminActor, DEV)).toEqual(ALLOWED);
    expect(authorizeAccess('admin', adminActor, PROD)).toEqual(ALLOWED);
  });

  it('rejects an anonymous caller as unauthorized', () => {
    expect(authorizeAccess('admin', none, PROD)).toEqual(UNAUTHORIZED);
  });

  it('rejects a full product session as forbidden (admins are not product users)', () => {
    expect(authorizeAccess('admin', full, PROD)).toEqual(FORBIDDEN);
  });

  it('rejects pending-2FA sessions and the billing-portal credential as forbidden', () => {
    expect(authorizeAccess('admin', pending, PROD)).toEqual(FORBIDDEN);
    expect(authorizeAccess('admin', billingPortal, PROD)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: admin-actor reaches ONLY the admin class', () => {
  it('is denied on every non-admin route class, in and out of production', () => {
    for (const routeClass of ROUTE_CLASSES) {
      if (routeClass === 'admin') continue;
      expect(authorizeAccess(routeClass, adminActor, DEV)).toEqual(FORBIDDEN);
      expect(authorizeAccess(routeClass, adminActor, PROD)).toEqual(FORBIDDEN);
    }
  });

  it('is denied on an undeclared route class', () => {
    expect(authorizeAccess(undefined, adminActor, DEV)).toEqual(FORBIDDEN);
  });
});

describe('authorizeAccess: dev-only', () => {
  it('allows an anonymous caller outside production', () => {
    expect(authorizeAccess('dev-only', none, DEV)).toEqual(ALLOWED);
  });

  it('allows a pending-2FA session outside production', () => {
    expect(authorizeAccess('dev-only', pending, DEV)).toEqual(ALLOWED);
  });

  it('answers not_found in production even for a full session', () => {
    expect(authorizeAccess('dev-only', full, PROD)).toEqual(NOT_FOUND);
  });
});
