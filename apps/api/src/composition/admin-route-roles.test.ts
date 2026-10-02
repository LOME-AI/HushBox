import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from '@hushbox/shared';
import { createApp } from '../app.js';
import { routeKey } from '../lib/context/index.js';
import { readRouteClass } from '../middleware/pipeline-markers.js';
import { routeAdmitsRole } from '../middleware/pipeline-admin.js';
import { ADMIN_ROUTE_ROLES } from './admin-route-roles.js';
import type { AdminRole } from '@hushbox/shared';

/**
 * The declarations read the way a request reads them: through the admin
 * stage's own lookup, which is the one implementation of whether a route
 * admits a role. Asking the map directly here would be a second derivation of
 * exactly what these assertions exist to hold.
 */
function admits(key: string, role: AdminRole): boolean {
  return routeAdmitsRole(ADMIN_ROUTE_ROLES, [key], role);
}

/**
 * The route keys the assembled router actually serves under the `admin` class.
 * Read off registrations rather than off `AppType`, so a route the type has
 * lost to the documented erasure hazard is still counted here — which is what
 * makes this walk a witness for the map's compile-time completeness rather than
 * a restatement of it.
 */
function servedAdminRouteKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const route of createApp().routes) {
    if (route.method === 'ALL') continue;
    if (readRouteClass(route.handler) !== 'admin') continue;
    keys.add(routeKey(route));
  }
  return keys;
}

describe('the admin route-roles map against the assembled router', () => {
  it('finds the admin-classed routes the walk exists to check', () => {
    // The positive control: a walk resolving no route class would report every
    // route declared and read exactly like a tree with nothing to report.
    expect(servedAdminRouteKeys().size).toBeGreaterThan(0);
  });

  it('declares roles for every admin route the router serves', () => {
    const undeclared = [...servedAdminRouteKeys()].filter(
      (key) => !Object.hasOwn(ADMIN_ROUTE_ROLES, key)
    );
    expect(undeclared).toEqual([]);
  });

  it('declares roles for no route the router does not serve', () => {
    const served = servedAdminRouteKeys();
    const orphans = Object.keys(ADMIN_ROUTE_ROLES).filter((key) => !served.has(key));
    expect(orphans).toEqual([]);
  });

  it('names only roles the closed set carries', () => {
    const unknown = Object.values(ADMIN_ROUTE_ROLES)
      .flat()
      .filter((role) => !(ADMIN_ROLES as readonly string[]).includes(role));
    expect(unknown).toEqual([]);
  });
});

describe('the declarations under the stage lookup', () => {
  it('refuses every role on a route the map does not declare', () => {
    for (const role of ADMIN_ROLES) {
      expect(admits('$get /admin/not-a-route', role)).toBe(false);
    }
  });

  it('refuses a key that names an Object.prototype member rather than resolving it', () => {
    for (const role of ADMIN_ROLES) {
      expect(admits('constructor', role)).toBe(false);
    }
  });

  it('admits a role the declaration lists', () => {
    expect(admits('$get /admin/dashboard', 'operator')).toBe(true);
  });
});

/**
 * The exhaustiveness the design asks for: iterating every served admin route
 * rather than a hand-written list, so a route added without a `growth-viewer`
 * decision is refused for that role by default and a route that DID grant it is
 * a visible diff here.
 */
describe('the growth-viewer role against every admin route', () => {
  it('is refused on every route whose declaration does not list it', () => {
    const wronglyAdmitted = [...servedAdminRouteKeys()].filter((key) => {
      const declared: readonly AdminRole[] = Object.hasOwn(ADMIN_ROUTE_ROLES, key)
        ? ((ADMIN_ROUTE_ROLES as Readonly<Record<string, readonly AdminRole[]>>)[key] ?? [])
        : [];
      return !declared.includes('growth-viewer') && admits(key, 'growth-viewer');
    });
    expect(wronglyAdmitted).toEqual([]);
  });

  it('reaches the operations surface and nothing else', () => {
    const reachable = [...servedAdminRouteKeys()]
      .filter((key) => admits(key, 'growth-viewer'))
      .toSorted((left, right) => left.localeCompare(right));
    expect(reachable).toEqual(['$get /admin/ops', '$post /admin/ops/:name/execute']);
  });
});
