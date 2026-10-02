import { describe, expect, it } from 'vitest';
import { ROUTE_CLASSES, authorizeAccess } from '../context/index.js';
import { CLASS_DEFAULTS, classDefaultFor } from './class-default.js';
import type { Principal, RouteClass, SessionClaims } from '../context/index.js';

const SAMPLE_ID = '{id}';

/** `toSorted` needs an explicit collation comparator (sonarjs/no-alphabetical-sort). */
const byText = (a: string, b: string): number => a.localeCompare(b);

const claims: SessionClaims = {
  userId: 'user',
  sessionId: 'session',
  createdAt: 0,
  pending2FA: false,
  pending2FAExpiresAt: 0,
};

/**
 * One principal of every kind the union carries, so "reaches no caller" is
 * total. The collection is keyed by `Principal['kind']` so the compiler holds
 * that totality rather than a reader: a kind added to the union leaves this
 * object missing a key and fails to compile, where a hand-written list would
 * leave the sweep silently partial and still read as exhaustive. The mapped
 * value type pins each principal to its own key, so a sample cannot drift onto
 * the wrong kind either.
 */
const EVERY_PRINCIPAL_KIND: readonly Principal[] = Object.values({
  none: { kind: 'none' },
  'pending-2fa': { kind: 'pending-2fa', claims },
  'billing-portal': {
    kind: 'billing-portal',
    credential: {
      credentialKind: 'billing-portal',
      userId: 'user-1',
      sessionId: 'credential-1',
      createdAt: 0,
    },
  },
  full: { kind: 'full', claims },
  'link-guest': { kind: 'link-guest', linkId: 'link', conversationId: 'conversation' },
  'admin-actor': {
    kind: 'admin-actor',
    email: 'admin@hushbox.ai',
    audience: 'aud',
    role: 'operator',
  },
  'trial-session': { kind: 'trial-session', sessionId: 'session' },
} satisfies { [K in Principal['kind']]: Extract<Principal, { kind: K }> });

/**
 * Read from the authorization matrix rather than asserted, so a class the
 * matrix opens in production enters the rule below without anyone noticing it
 * has to.
 */
function reachableInProduction(routeClass: RouteClass): boolean {
  return EVERY_PRINCIPAL_KIND.some(
    (principal) => authorizeAccess(routeClass, principal, { isProduction: true }).allowed
  );
}

describe('the class defaults', () => {
  it('gives every route class exactly one default', () => {
    expect(Object.keys(CLASS_DEFAULTS).toSorted(byText)).toEqual(
      [...ROUTE_CLASSES].toSorted(byText)
    );
  });

  it('caps each class at the reasoned backstop, per sixty seconds', () => {
    const table = Object.fromEntries(
      Object.entries(CLASS_DEFAULTS).map(([cls, row]) => [
        cls,
        [row.identity, row.definition.maxAttempts, row.definition.windowSeconds],
      ])
    );
    expect(table).toEqual({
      public: ['ip', 600, 60],
      session: ['user', 600, 60],
      admin: ['admin-actor', 600, 60],
      'billing-token': ['session-user', 600, 60],
      'pending-2fa': ['ip', 600, 60],
      'dev-only': ['ip', 3000, 60],
    });
  });

  // The one rule the rationale states over rows rather than inside one: an
  // address-keyed key stands for a population rather than a person, so every
  // such row a production caller can reach is sized at `session`'s backstop,
  // and a row no production caller reaches is sized by its own argument. A new
  // address-keyed class the matrix opens is missing from this record until its
  // cap follows the rule, and a reachable row sized away from the backstop
  // shows the number it moved to.
  it('sizes every production-reachable address-keyed default at the session backstop', () => {
    const backstop = CLASS_DEFAULTS.session.definition.maxAttempts;
    const reachableAddressKeyed = Object.fromEntries(
      ROUTE_CLASSES.filter(
        (routeClass) =>
          CLASS_DEFAULTS[routeClass].identity === 'ip' && reachableInProduction(routeClass)
      ).map((routeClass) => [routeClass, CLASS_DEFAULTS[routeClass].definition.maxAttempts])
    );

    expect(reachableAddressKeyed).toEqual({
      public: backstop,
      'pending-2fa': backstop,
    });
  });

  it('keys every class admitting only session-bearing callers on the account', () => {
    // The rule the rows follow, stated over rows rather than inside one: an
    // address is what a class falls back to when it admits a caller carrying
    // no session at all. A class whose matrix admits only session-bearing
    // principals is keyed on the account, so one caller's window is their own
    // rather than their network's.
    const sessionBearingOnly = ROUTE_CLASSES.filter(
      (routeClass) =>
        !authorizeAccess(routeClass, { kind: 'none' }, { isProduction: false }).allowed &&
        reachableInProduction(routeClass)
    );

    expect(
      Object.fromEntries(
        sessionBearingOnly.map((routeClass) => [routeClass, CLASS_DEFAULTS[routeClass].identity])
      )
    ).toEqual({ session: 'user', admin: 'admin-actor', 'billing-token': 'session-user' });
  });

  it('counts every default as a throttle, which reserves nothing and never clears', () => {
    const kinds = Object.values(CLASS_DEFAULTS).map((row) => row.definition.kind);
    expect(new Set(kinds)).toEqual(new Set(['throttle']));
  });

  it('gives every default a counter key no other default shares', () => {
    const keys = Object.values(CLASS_DEFAULTS).map((row) => row.definition.buildKey(SAMPLE_ID));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the class default one route spends', () => {
  it('qualifies the class counter by the route the default backs', () => {
    expect(
      classDefaultFor('public', { method: 'GET', path: '/models' }).definition.buildKey(SAMPLE_ID)
    ).toBe(`ratelimit:default:public:$get /models:${SAMPLE_ID}`);
  });

  it('gives two routes of one class two counters for one identity', () => {
    expect(
      classDefaultFor('session', { method: 'GET', path: '/conversations' }).definition.buildKey(
        SAMPLE_ID
      )
    ).not.toBe(
      classDefaultFor('session', { method: 'GET', path: '/conversations/:id' }).definition.buildKey(
        SAMPLE_ID
      )
    );
  });

  it('gives two methods of one path two counters for one identity', () => {
    expect(
      classDefaultFor('session', {
        method: 'GET',
        path: '/account/instructions',
      }).definition.buildKey(SAMPLE_ID)
    ).not.toBe(
      classDefaultFor('session', {
        method: 'DELETE',
        path: '/account/instructions',
      }).definition.buildKey(SAMPLE_ID)
    );
  });

  it("carries its class's identity, cap and window through unchanged", () => {
    const forRoute = classDefaultFor('admin', { method: 'POST', path: '/admin/ops' });
    const forClass = CLASS_DEFAULTS.admin;

    expect([
      forRoute.identity,
      forRoute.definition.kind,
      forRoute.definition.maxAttempts,
      forRoute.definition.windowSeconds,
    ]).toEqual([
      forClass.identity,
      forClass.definition.kind,
      forClass.definition.maxAttempts,
      forClass.definition.windowSeconds,
    ]);
  });
});
