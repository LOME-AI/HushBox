import { describe, expect, it } from 'vitest';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { ROUTE_CACHE_POLICIES } from './route-cache-policy.js';
import type { RouteKey } from './app-route-key.js';
import type { CachePolicy } from '../lib/cache-policy/index.js';

const STORABLE_ROUTES = [
  '$get /announcements/banner',
  '$get /models',
  '$get /models/:model/:version/:file',
  '$get /public/roadmap',
  '$get /public/stats',
  '$get /updates/download/:platform/:version',
];

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('what the map declares storable', () => {
  it('permits a shared cache to store exactly the reviewed routes', () => {
    const storable = Object.entries(ROUTE_CACHE_POLICIES)
      .filter(([, policy]) => policy.kind !== 'no-store')
      .map(([key]) => key);
    expect(storable.toSorted(byName)).toEqual(STORABLE_ROUTES.toSorted(byName));
  });

  it('declares a no-store policy for every other route', () => {
    const otherKinds = new Set(
      Object.entries(ROUTE_CACHE_POLICIES)
        .filter(([key]) => !STORABLE_ROUTES.includes(key))
        .map(([, policy]) => policy.kind)
    );
    expect([...otherKinds]).toEqual(['no-store']);
  });

  it('names a purge tag on every storable declaration', () => {
    const untagged = Object.entries(ROUTE_CACHE_POLICIES)
      .filter(([, policy]) => policy.kind !== 'no-store' && policy.tag.length === 0)
      .map(([key]) => key);
    expect(untagged).toEqual([]);
  });
});

describe('the lifetime each storable route declares', () => {
  it('binds the OTA bundle to every cache, since a version can never change under its URL', () => {
    expect(ROUTE_CACHE_POLICIES['$get /updates/download/:platform/:version']).toEqual({
      kind: 'immutable',
      maxAgeSeconds: 86_400,
      tag: 'ota',
    });
  });

  it('binds the banner to shared caches for a minute', () => {
    expect(ROUTE_CACHE_POLICIES['$get /announcements/banner']).toEqual({
      kind: 'shared',
      sharedMaxAgeSeconds: 60,
      tag: 'banner',
    });
  });

  it('binds a model artifact to every cache for a year, its version being in its path', () => {
    expect(ROUTE_CACHE_POLICIES['$get /models/:model/:version/:file']).toEqual({
      kind: 'immutable',
      maxAgeSeconds: 31_536_000,
      tag: 'model-weights',
    });
  });

  it('binds the model catalog to shared caches for a minute', () => {
    expect(ROUTE_CACHE_POLICIES['$get /models']).toEqual({
      kind: 'shared',
      sharedMaxAgeSeconds: 60,
      tag: 'catalog',
    });
  });

  it('lets the stats snapshot serve stale while it refreshes', () => {
    expect(ROUTE_CACHE_POLICIES['$get /public/stats']).toEqual({
      kind: 'shared',
      sharedMaxAgeSeconds: 3600,
      staleWhileRevalidateSeconds: 600,
      tag: 'stats',
    });
  });

  it('lets the roadmap serve stale for a day when its upstream is unreachable', () => {
    expect(ROUTE_CACHE_POLICIES['$get /public/roadmap']).toEqual({
      kind: 'shared',
      sharedMaxAgeSeconds: 3600,
      staleWhileRevalidateSeconds: 600,
      staleIfErrorSeconds: 86_400,
      tag: 'roadmap',
    });
  });
});

/**
 * Compile-time assertions: each `@ts-expect-error` claims the marked expression
 * DOES NOT compile, so the completeness witness going slack flags the directive
 * as unused and fails `pnpm typecheck`. Without these, `satisfies` is a clause a
 * reader has to trust rather than a property something checks.
 */
describe('the completeness witness (compile-time)', () => {
  it('refuses a map that leaves a route in the key union undeclared', () => {
    const declareAgainstAWiderRouter = (): unknown =>
      // @ts-expect-error — the widened union names a route the map does not declare
      ROUTE_CACHE_POLICIES satisfies Record<
        RouteKey | '$get /a-route-the-map-does-not-declare',
        CachePolicy
      >;
    expectCompileTimeProof(declareAgainstAWiderRouter);
  });

  it('refuses a map key that names no route', () => {
    const declareARouteTheRouterDoesNotServe = (): unknown =>
      ({
        ...ROUTE_CACHE_POLICIES,
        // @ts-expect-error — a key naming no route is an excess property
        '$get /a-route-the-router-does-not-serve': { kind: 'no-store' },
      }) satisfies Record<RouteKey, CachePolicy>;
    expectCompileTimeProof(declareARouteTheRouterDoesNotServe);
  });
});
