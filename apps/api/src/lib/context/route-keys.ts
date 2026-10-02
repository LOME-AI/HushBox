import { matchedRoutes } from 'hono/route';
import type { AppEnv } from './app-env.js';
import type { Context } from 'hono';
import type { RouterRoute } from 'hono/types';

/**
 * The router's own spelling of a registration — the runtime half of the key
 * `RouteKeyOf` derives at the type level. Every route-keyed declaration map is
 * looked up with this, so a second rendering would let two maps be enforced
 * against different keys for the same route.
 */
export function routeKey(route: Pick<RouterRoute, 'method' | 'path'>): string {
  return `$${route.method.toLowerCase()} ${route.path}`;
}

/**
 * `.use()` mounts register under the `ALL` pseudo-method and declare no route
 * of their own — every pipeline stage and every edge-ring middleware is one —
 * so the method filter is what reduces a registration set to real routes. A
 * class marker and the terminal handler it guards register under one method
 * and path, and collapse to one key.
 */
function routeKeysOf(routes: readonly RouterRoute[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const route of routes) {
    if (route.method === 'ALL') continue;
    keys.add(routeKey(route));
  }
  return keys;
}

/** The route keys of this request's matched registrations. */
export function matchedRouteKeys(c: Context<AppEnv>): readonly string[] {
  return [...routeKeysOf(matchedRoutes(c))];
}

/**
 * The route keys the assembled router serves. It reads registrations rather
 * than `AppType`, so a route a slice has lost to the silent type-erasure hazard
 * is still counted — which is what makes a walk over this a witness for the
 * compile-time completeness checks rather than a restatement of them.
 */
export function registeredRouteKeys(routes: readonly RouterRoute[]): ReadonlySet<string> {
  return routeKeysOf(routes);
}
