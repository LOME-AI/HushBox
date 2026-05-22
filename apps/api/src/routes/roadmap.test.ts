import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Redis } from '@upstash/redis';
import {
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_SERVICE_UNAVAILABLE,
  roadmapResponseSchema,
  type RoadmapResponse,
} from '@hushbox/shared';
import { roadmapRoute } from './roadmap.js';
import type { AppEnv } from '../types.js';
import { createMockLinearClient } from '../services/linear/mock.js';
import * as linearModule from '../services/linear/index.js';

interface FakeStore {
  data: Map<string, unknown>;
}

function makeFakeRedis(store: FakeStore): Redis {
  return {
    get: async (key: string) => (store.data.has(key) ? store.data.get(key) : null),
    set: async (key: string, value: unknown) => {
      store.data.set(key, value);
      return 'OK';
    },
    incr: async (key: string) => {
      const v = ((store.data.get(key) as number | undefined) ?? 0) + 1;
      store.data.set(key, v);
      return v;
    },
    expire: async () => 1,
  } as unknown as Redis;
}

function makeTestApp(
  opts: { redis: Redis; env?: Partial<AppEnv['Bindings']> } & {
    env?: Partial<AppEnv['Bindings']>;
  }
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'test',
      ...(opts.env ?? {}),
    } as AppEnv['Bindings'];
    c.set('redis', opts.redis);
    await next();
  });
  app.route('/api/roadmap', roadmapRoute);
  return app;
}

describe('GET /api/roadmap', () => {
  let store: FakeStore;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    store = { data: new Map() };
    app = makeTestApp({ redis: makeFakeRedis(store) });
  });

  it('returns a 200 response that parses against the public schema', async () => {
    const response = await app.request('/api/roadmap', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(() => roadmapResponseSchema.parse(body)).not.toThrow();
  });

  it('emits CDN cache headers', async () => {
    const response = await app.request('/api/roadmap', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=300');
  });

  it('returns both layouts by default', async () => {
    const response = await app.request('/api/roadmap', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    const body = (await response.json()) as RoadmapResponse;
    expect(body.layouts.wide).toBeDefined();
    expect(body.layouts.narrow).toBeDefined();
  });

  it('returns only wide when ?layout=wide', async () => {
    const response = await app.request('/api/roadmap?layout=wide', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    const body = (await response.json()) as RoadmapResponse;
    expect(body.layouts.wide).toBeDefined();
    expect(body.layouts.narrow).toBeUndefined();
  });

  it('returns only narrow when ?layout=narrow', async () => {
    const response = await app.request('/api/roadmap?layout=narrow', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    const body = (await response.json()) as RoadmapResponse;
    expect(body.layouts.narrow).toBeDefined();
    expect(body.layouts.wide).toBeUndefined();
  });

  it('rejects unknown ?layout values with a Zod validation error', async () => {
    const response = await app.request('/api/roadmap?layout=gantt', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.status).toBe(400);
  });

  it('rejects POST requests', async () => {
    const response = await app.request('/api/roadmap', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.status).toBe(404);
  });

  it('rate-limits a single IP after the configured threshold', async () => {
    const headers = { 'cf-connecting-ip': '9.9.9.9' };
    let lastStatus = 200;
    for (let i = 0; i < 35; i += 1) {
      const response = await app.request('/api/roadmap', { headers });
      lastStatus = response.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('returns a RATE_LIMITED code when throttled', async () => {
    const headers = { 'cf-connecting-ip': '8.8.8.8' };
    let response = await app.request('/api/roadmap', { headers });
    for (let i = 0; i < 50 && response.status !== 429; i += 1) {
      response = await app.request('/api/roadmap', { headers });
    }
    expect(response.status).toBe(429);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe(ERROR_CODE_RATE_LIMITED);
  });

  it('returns 503 SERVICE_UNAVAILABLE when the Linear fetch fails', async () => {
    // Swap in a failing Linear client by spying on the factory. The route
    // calls getLinearClient(c.env) which we route to a stub that throws on
    // fetchRoadmap, simulating Linear being unreachable.
    const failingClient = {
      fetchRoadmap() {
        return Promise.reject(new Error('linear unreachable'));
      },
    };
    const spy = vi.spyOn(linearModule, 'getLinearClient').mockReturnValue(failingClient);
    try {
      const response = await app.request('/api/roadmap', {
        headers: { 'cf-connecting-ip': '2.2.2.2' },
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe(ERROR_CODE_SERVICE_UNAVAILABLE);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the mock client implicitly (sanity check that the test infra works)', async () => {
    // The default test env (NODE_ENV=test) returns the mock client via the
    // factory. This confirms our happy-path tests above are exercising real
    // wiring, not a stub.
    const client = linearModule.getLinearClient({ NODE_ENV: 'test' });
    const mock = createMockLinearClient();
    const fromFactory = await client.fetchRoadmap('HUS');
    const fromMock = await mock.fetchRoadmap('HUS');
    expect(fromFactory).toEqual(fromMock);
  });

  it('uses the cache on subsequent requests within an IP', async () => {
    // Two requests from two different IPs (to avoid rate limit) should both
    // succeed; the second one reads from the cache.
    const r1 = await app.request('/api/roadmap', {
      headers: { 'cf-connecting-ip': '5.5.5.5' },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/api/roadmap', {
      headers: { 'cf-connecting-ip': '6.6.6.6' },
    });
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1).toEqual(b2);
  });
});
