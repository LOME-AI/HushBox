import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, publicUsageStatsSchema } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { cacheDirectives } from '../../lib/cache-policy/index.js';
import { bindRequestValue, createRequestDb } from '../../lib/context/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createPublicStatsStores } from '../billing/index.js';
import { STATS_ROUTE_POSTURES } from './rate-limit-posture.js';
import { createStatsManifest } from './routes.js';
import type { Redis } from '@upstash/redis';
import type { PublicUsageStats } from '@hushbox/shared';
import type { AppEnv, Bindings, RequiredBindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { PublicStatsSnapshotRow, PublicStatsStores } from '../billing/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for stats route integration tests`);
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

function validStats(): PublicUsageStats {
  return {
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    modalities: {
      text: {
        all: {
          models: [
            {
              modelId: 'openai/gpt-5',
              displayName: 'GPT-5',
              provider: 'OpenAI',
              sharePercent: 62.5,
              deltaPoints: null,
              avgCostUsd: '0.0051',
            },
          ],
          others: { sharePercent: 37.5, deltaPoints: null },
          trend: { bucket: 'month', points: [] },
          cost: { avgUsd: '0.004', medianUsd: '0.003', p90Usd: '0.009' },
        },
      },
    },
  };
}

function snapshotRow(stats: unknown): PublicStatsSnapshotRow {
  return {
    id: crypto.randomUUID(),
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    stats,
    createdAt: new Date(),
  };
}

/**
 * A counting stores fake at the manifest's test seam (production binds the
 * real billing stores in the composition root). Only the read the route
 * exercises is live; every other member throws if reached.
 */
function fakeStores(options: { row?: PublicStatsSnapshotRow | null; fail?: boolean }): {
  stores: PublicStatsStores;
  reads: () => number;
} {
  let reads = 0;
  const unreachable = (): never => {
    throw new Error('unreachable store member for GET /public/stats');
  };
  return {
    stores: {
      aggregateGlobalUsageByModel: unreachable,
      readGlobalCostPercentiles: unreachable,
      readGlobalTrendCounts: unreachable,
      insertPublicStatsSnapshot: unreachable,
      readLatestPublicStatsSnapshot: () => {
        reads += 1;
        if (options.fail === true) return errAsync(unavailableError('db down'));
        return okAsync(options.row ?? null);
      },
    },
    reads: () => reads,
  };
}

function buildApp(stores: PublicStatsStores): Hono<AppEnv> {
  const manifest = createStatsManifest({ stores });
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
    rateLimit: { postures: STATS_ROUTE_POSTURES },
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
function buildRedislessApp(stores: PublicStatsStores): Hono<AppEnv> {
  const manifest = createStatsManifest({ stores });
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

async function getStats(app: Hono<AppEnv>, headers: Record<string, string>): Promise<Response> {
  return app.request('/public/stats', { headers }, testEnv);
}

/**
 * Derived from the declaration the stage renders rather than written out: a
 * literal here would be one more place the tag has to agree, which is the
 * drift `CODE-RULES.md` §One Implementation, Shared bans.
 */
const DECLARED_CACHE_TAG = cacheDirectives(ROUTE_CACHE_POLICIES['$get /public/stats']).cacheTag;

describe('GET /public/stats', () => {
  it('serves the latest matching-version snapshot payload with its declared cache directive', async () => {
    const stats = validStats();
    const fake = fakeStores({ row: snapshotRow(stats) });
    const res = await getStats(buildApp(fake.stores), uniqueIpHeaders());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=600'
    );
    expect(res.headers.get('Cache-Tag')).toBe(DECLARED_CACHE_TAG);
    expect(await readJson<PublicUsageStats>(res)).toEqual(stats);
  });

  it('reads the snapshot store afresh on every call, holding no copy of its own', async () => {
    const stats = validStats();
    const fake = fakeStores({ row: snapshotRow(stats) });
    const app = buildApp(fake.stores);

    const first = await getStats(app, uniqueIpHeaders());
    expect(first.status).toBe(200);
    const second = await getStats(app, uniqueIpHeaders());
    expect(second.status).toBe(200);
    expect(fake.reads()).toBe(2);
    expect(await second.json()).toEqual(await first.json());
  });

  it('serves the snapshot payload with no reachable Redis behind it', async () => {
    const stats = validStats();
    const fake = fakeStores({ row: snapshotRow(stats) });
    const res = await getStats(buildRedislessApp(fake.stores), uniqueIpHeaders());
    expect(res.status).toBe(200);
    expect(await readJson<PublicUsageStats>(res)).toEqual(stats);
  });

  it('answers 503 SERVICE_UNAVAILABLE when no snapshot row exists (no fallback computation)', async () => {
    const fake = fakeStores({ row: null });
    const res = await getStats(buildApp(fake.stores), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers 503 when the snapshot store read fails', async () => {
    const fake = fakeStores({ fail: true });
    const res = await getStats(buildApp(fake.stores), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers 503 when the stored payload fails the public schema', async () => {
    const fake = fakeStores({ row: snapshotRow({ not: 'a valid payload' }) });
    const res = await getStats(buildApp(fake.stores), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('serves through the real billing stores the composition root binds', async () => {
    // Seed one real snapshot row so the shared-DB path is deterministic; the
    // endpoint serves the LATEST matching row, which may be a later writer's —
    // assert shape, not identity.
    const seed = await createPublicStatsStores().insertPublicStatsSnapshot(
      createRequestDb(testEnv as RequiredBindings, { isDev: true }),
      { schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION, stats: validStats() }
    );
    expect(seed.isOk()).toBe(true);

    const manifest = createStatsManifest({ stores: createPublicStatsStores() });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/public/stats', { headers: uniqueIpHeaders() }, testEnv);
    expect(res.status).toBe(200);
    const body = await readJson<unknown>(res);
    expect(publicUsageStatsSchema.safeParse(body).success).toBe(true);
  });

  it('rate-limits the 31st request in a minute from one IP with 429', async () => {
    const fake = fakeStores({ row: snapshotRow(validStats()) });
    const app = buildApp(fake.stores);
    const headers = uniqueIpHeaders();

    for (let call = 0; call < 30; call += 1) {
      const res = await getStats(app, headers);
      expect(res.status).toBe(200);
    }
    const blocked = await getStats(app, headers);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await readJson<{ code: string }>(blocked);
    expect(body.code).toBe('RATE_LIMITED');
  });
});
