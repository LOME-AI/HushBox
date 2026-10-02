import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { LINEAR_TEAM_KEY } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { cacheDirectives } from '../../lib/cache-policy/index.js';
import { bindRequestValue } from '../../lib/context/index.js';
import { getLinearClient } from './adapters/linear-client.js';
import { createRoadmapManifest } from './routes.js';
import { ROADMAP_ROUTE_POSTURES } from './rate-limit-posture.js';
import { MOCK_ISSUES, MOCK_PROJECTS } from './adapters/mock-roadmap-fixture.js';
import type { Redis } from '@upstash/redis';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { LinearClient, LinearRoadmapData } from './ports/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for roadmap route integration tests`);
  }
  return value;
}

/** Typed JSON read severed from hono's Response inference (json() is unknown here). */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

/** A counting Linear fake; `fail` makes every fetch throw. */
function fakeLinear(options: { fail?: boolean; issueCount?: number } = {}): {
  client: LinearClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    client: {
      fetchRoadmap: (): Promise<LinearRoadmapData> => {
        calls += 1;
        if (options.fail === true) throw new Error('linear down');
        if (options.issueCount !== undefined) {
          return Promise.resolve({
            projects: MOCK_PROJECTS,
            issues: Array.from({ length: options.issueCount }, (_, index) => ({
              id: `mass-${String(index)}`,
              title: `Issue ${String(index)}`,
              stateName: 'Todo',
              stateType: 'unstarted' as const,
              labelNames: ['type:feature'],
              parentId: null,
              projectId: null,
              relations: [],
            })),
          });
        }
        return Promise.resolve({ projects: MOCK_PROJECTS, issues: MOCK_ISSUES });
      },
    },
    calls: () => calls,
  };
}

function buildApp(linear: LinearClient): Hono<AppEnv> {
  const manifest = createRoadmapManifest({ linear: () => linear, teamKey: LINEAR_TEAM_KEY });
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
    rateLimit: { postures: ROADMAP_ROUTE_POSTURES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/**
 * Every Redis operation rejects, injected at the `c.var.redis` seam rather than
 * by pointing the client at an unreachable host — the same shape
 * `slices/identity/routes-redis-unavailable.integration.test.ts` uses, and for
 * its reason: Upstash's connect/retry/backoff is vendor behaviour and costs
 * seconds per call.
 */
const DEAD_REDIS = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === 'createScript'
        ? () => ({ exec: (): Promise<never> => Promise.reject(new Error('redis unavailable')) })
        : (): Promise<never> => Promise.reject(new Error('redis unavailable')),
  }
) as unknown as Redis;

/**
 * The route behind a Redis that answers nothing. No rate-limit postures are
 * mounted: the per-address throttle is a Redis consumer in its own right, and
 * what this app isolates is the handler's own dependency on the backend.
 */
function buildRedislessApp(linear: LinearClient): Hono<AppEnv> {
  const manifest = createRoadmapManifest({ linear: () => linear, teamKey: LINEAR_TEAM_KEY });
  const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
  app.use('*', async (c, next) => {
    bindRequestValue(c, 'redis', DEAD_REDIS);
    await next();
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/**
 * A fresh address per call. The per-IP throttle these tests mount counts in the
 * shared local Redis, so a reused address would couple them and eventually
 * refuse their own later runs.
 */
function uniqueIpHeaders(): Record<string, string> {
  return { 'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}` };
}

async function getRoadmap(app: Hono<AppEnv>, headers: Record<string, string>): Promise<Response> {
  return app.request('/public/roadmap', { headers }, testEnv);
}

/**
 * Derived from the declaration the stage renders rather than written out: a
 * literal here would be one more place the tag has to agree, which is the
 * drift `CODE-RULES.md` §One Implementation, Shared bans.
 */
const DECLARED_CACHE_TAG = cacheDirectives(ROUTE_CACHE_POLICIES['$get /public/roadmap']).cacheTag;

describe('GET /public/roadmap', () => {
  it('serves the normalized public shape with its declared cache directive', async () => {
    const linear = fakeLinear();
    const res = await getRoadmap(buildApp(linear.client), uniqueIpHeaders());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=600, stale-if-error=86400'
    );
    expect(res.headers.get('Cache-Tag')).toBe(DECLARED_CACHE_TAG);
    const body = await readJson<{ nodes: { id: string; kind: string }[] }>(res);
    expect(body.nodes.length).toBeGreaterThan(0);
    // Opaque ids only — no raw mock-prefixed Linear id may leak.
    expect(body.nodes.every((node) => /^[0-9a-f]{12}$/.test(node.id))).toBe(true);
  });

  it('calls Linear afresh on every call, holding no copy of the board', async () => {
    const linear = fakeLinear();
    const app = buildApp(linear.client);

    const first = await getRoadmap(app, uniqueIpHeaders());
    expect(first.status).toBe(200);
    const second = await getRoadmap(app, uniqueIpHeaders());
    expect(second.status).toBe(200);
    expect(linear.calls()).toBe(2);
    expect(await second.json()).toEqual(await first.json());
  });

  it('serves the normalized board with no reachable Redis behind it', async () => {
    const linear = fakeLinear();
    const res = await getRoadmap(buildRedislessApp(linear.client), uniqueIpHeaders());
    expect(res.status).toBe(200);
    const body = await readJson<{ nodes: unknown[] }>(res);
    expect(body.nodes.length).toBeGreaterThan(0);
  });

  it('answers 503 SERVICE_UNAVAILABLE when Linear fails', async () => {
    const linear = fakeLinear({ fail: true });
    const res = await getRoadmap(buildApp(linear.client), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers 503 when the normalized response fails the public schema (>500 nodes)', async () => {
    const linear = fakeLinear({ issueCount: 501 });
    const res = await getRoadmap(buildApp(linear.client), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it("serves the committed fixture under the composition root's own wiring", async () => {
    // The exact bindings app.ts passes: env-mode dispatch resolves the mock
    // client in local-dev mode.
    const manifest = createRoadmapManifest({
      linear: getLinearClient,
      teamKey: LINEAR_TEAM_KEY,
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/public/roadmap', { headers: uniqueIpHeaders() }, testEnv);
    expect(res.status).toBe(200);
    const body = await readJson<{ nodes: unknown[] }>(res);
    expect(body.nodes.length).toBeGreaterThan(0);
  });

  it('rate-limits the 31st request in a minute from one IP with 429', async () => {
    const linear = fakeLinear();
    const app = buildApp(linear.client);
    const headers = uniqueIpHeaders();

    for (let call = 0; call < 30; call += 1) {
      const res = await getRoadmap(app, headers);
      expect(res.status).toBe(200);
    }
    const blocked = await getRoadmap(app, headers);
    expect(blocked.status).toBe(429);
    const body = await readJson<{ code: string }>(blocked);
    expect(body.code).toBe('RATE_LIMITED');
  });
});
