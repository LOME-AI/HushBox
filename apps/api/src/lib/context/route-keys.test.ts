import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { matchedRouteKeys, registeredRouteKeys, routeKey } from './route-keys.js';
import type { AppEnv } from './app-env.js';

describe('routeKey', () => {
  it('renders the router registration as the key a route-keyed map is looked up with', () => {
    expect(routeKey({ method: 'GET', path: '/widgets/:id' })).toBe('$get /widgets/:id');
  });
});

describe('registeredRouteKeys', () => {
  it('renders every registration the router serves', () => {
    const app = new Hono().get('/widgets', (c) => c.json({ ok: true }));
    expect([...registeredRouteKeys(app.routes)]).toStrictEqual(['$get /widgets']);
  });

  it('drops the pseudo-method a middleware mount registers under', () => {
    const app = new Hono()
      .use('/widgets', async (_c, next) => next())
      .get('/widgets', (c) => c.json({ ok: true }));
    expect([...registeredRouteKeys(app.routes)]).toStrictEqual(['$get /widgets']);
  });

  it('collapses two registrations of one method and path onto one key', () => {
    const app = new Hono().get(
      '/widgets',
      async (_c, next) => next(),
      (c) => c.json({ ok: true })
    );
    expect([...registeredRouteKeys(app.routes)]).toStrictEqual(['$get /widgets']);
  });
});

describe('matchedRouteKeys', () => {
  it('renders the registrations this request matched', async () => {
    const seen: string[][] = [];
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        await next();
        seen.push([...matchedRouteKeys(c)]);
      })
      .get('/widgets/:id', (c) => c.json({ ok: true }));

    await app.request('/widgets/7');

    expect(seen).toStrictEqual([['$get /widgets/:id']]);
  });

  it('renders no key for a request that matched no route', async () => {
    const seen: string[][] = [];
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        await next();
        seen.push([...matchedRouteKeys(c)]);
      })
      .get('/widgets', (c) => c.json({ ok: true }));

    await app.request('/gadgets');

    expect(seen).toStrictEqual([[]]);
  });
});
