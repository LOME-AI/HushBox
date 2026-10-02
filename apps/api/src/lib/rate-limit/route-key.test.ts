import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ExtractSchema } from 'hono/types';
import type { RouteKeyOf, SliceRouteKey } from './route-key.js';

const manifest = {
  basePath: '/widgets' as const,
  routes: new Hono()
    .get('/', (c) => c.json({ ok: true }))
    .post('/:id/rename', (c) => c.json({ ok: true })),
};

describe('the manifest under test', () => {
  it('registers exactly the two routes RouteKeyOf and SliceRouteKey derive', () => {
    expect(
      manifest.routes.routes.map((route) => `$${route.method.toLowerCase()} ${route.path}`)
    ).toStrictEqual(['$get /', '$post /:id/rename']);
  });
});

describe('RouteKeyOf', () => {
  it('pairs every method with its own path', () => {
    expectTypeOf<RouteKeyOf<ExtractSchema<typeof manifest.routes>>>().toEqualTypeOf<
      '$get /' | '$post /:id/rename'
    >();
  });
});

describe('SliceRouteKey', () => {
  it("prefixes a manifest's routes exactly as mounting it does", () => {
    expectTypeOf<SliceRouteKey<typeof manifest>>().toEqualTypeOf<
      '$get /widgets' | '$post /widgets/:id/rename'
    >();
  });
});
