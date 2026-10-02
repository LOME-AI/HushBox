import { afterAll, describe, it } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { proveCallerInvariance } from '../../test-support/caller-invariance.js';
import { createModelsManifest } from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/**
 * The catalog list is declared storable by a shared cache, which licenses
 * replaying one caller's response to a stranger. This is the proof that claim
 * rests on; the arch rule `cacheable-routes-prove-caller-invariance` is what
 * requires it to exist.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the models caller-invariance proof`);
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

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** A listed model, so the proof runs over a body with content in it. */
const MODEL_ID = `caller-invariance-${crypto.randomUUID().slice(0, 8)}/text`;

async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL_ID,
      descriptor: {
        id: MODEL_ID,
        provider: 'caller-invariance',
        version: '3',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: { contextLength: 128_000 },
        pricing: { kind: 'tokens', anchor: { base: { input: '100', output: '200' }, tiers: [] } },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

function createApp(): Hono<AppEnv> {
  const manifest = createModelsManifest();
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

afterAll(async () => {
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL_ID]));
  await db.$client.end();
});

describe('GET /models is invariant across callers', () => {
  it('answers a session, an address, credentials and a query with identical bytes', async () => {
    await seedModel();

    await proveCallerInvariance('$get /models', {
      path: '/models',
      sessionSecret: SESSION_SECRET,
      databaseUrl: DATABASE_URL,
      // The list is built from the global catalog rows. A per-user filter
      // grown here would arrive with a table whose row goes in this hook.
      seedIdentifiedState: () => Promise.resolve(),
      respondTo: async ({ path, headers }) => createApp().request(path, { headers }, testEnv),
    });
  });
});
