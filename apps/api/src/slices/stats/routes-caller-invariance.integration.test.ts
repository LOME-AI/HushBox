import { describe, it } from 'vitest';
import { Hono } from 'hono';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { okAsync } from '../../lib/result/index.js';
import { proveCallerInvariance } from '../../test-support/caller-invariance.js';
import { createStatsManifest } from './routes.js';
import type { PublicUsageStats } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { PublicStatsSnapshotRow, PublicStatsStores } from '../billing/index.js';

/**
 * The public stats payload is declared storable by a shared cache, which
 * licenses replaying one caller's response to a stranger. This is the proof
 * that claim rests on; the arch rule `cacheable-routes-prove-caller-invariance`
 * requires it to exist.
 *
 * Both responses are BUILT: the route reads the snapshot row on every call and
 * holds no copy of its own, so neither caller can be answered out of the
 * other's.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the public-stats caller-invariance proof`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SESSION_SECRET,
  TELEMETRY_SINKS: 'console',
};

/** One payload, built once, so two independent builds serve the same bytes. */
const STATS: PublicUsageStats = {
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

const SNAPSHOT: PublicStatsSnapshotRow = {
  id: crypto.randomUUID(),
  schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
  stats: STATS,
  createdAt: new Date(),
};

/** Only the read the route exercises is live; every other member throws. */
function fakeStores(): PublicStatsStores {
  const unreachable = (): never => {
    throw new Error('unreachable store member for the public-stats caller-invariance proof');
  };
  return {
    aggregateGlobalUsageByModel: unreachable,
    readGlobalCostPercentiles: unreachable,
    readGlobalTrendCounts: unreachable,
    insertPublicStatsSnapshot: unreachable,
    readLatestPublicStatsSnapshot: () => okAsync(SNAPSHOT),
  };
}

function createApp(): Hono<AppEnv> {
  const manifest = createStatsManifest({ stores: fakeStores() });
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

describe('GET /public/stats is invariant across callers', () => {
  it('answers a session, an address, credentials and a query with identical bytes', async () => {
    await proveCallerInvariance('$get /public/stats', {
      path: '/public/stats',
      sessionSecret: SESSION_SECRET,
      databaseUrl: DATABASE_URL,
      // The payload is the global snapshot row. A per-user cut grown here
      // would arrive with a table whose row goes in this hook.
      seedIdentifiedState: () => Promise.resolve(),
      respondTo: async ({ path, headers }) => createApp().request(path, { headers }, testEnv),
    });
  });
});
