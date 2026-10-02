import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { registeredRouteKeys } from '../lib/context/index.js';
import { ROUTE_CACHE_POLICIES } from './route-cache-policy.js';

/**
 * The witness map's own witness. `ROUTE_CACHE_POLICIES` is checked against
 * `AppType` by the compiler, which sees only the routes the `.route()` chain
 * carries into that type; a route a slice loses to type erasure reaches
 * `RouteKey` as no key at all, so the compiler cannot ask for a declaration it
 * has no name for. Walking the router the app assembles is what reaches such a
 * route, which is still a registration there.
 */
describe('the cache-policy map against the assembled router', () => {
  it('declares a cache policy for every route the router serves', () => {
    const undeclared = [...registeredRouteKeys(createApp().routes)].filter(
      (key) => !(key in ROUTE_CACHE_POLICIES)
    );
    expect(undeclared).toEqual([]);
  });

  it('declares a cache policy for no route the router does not serve', () => {
    const registered = registeredRouteKeys(createApp().routes);
    const orphans = Object.keys(ROUTE_CACHE_POLICIES).filter((key) => !registered.has(key));
    expect(orphans).toEqual([]);
  });
});
