import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { applyPipeline } from '../../middleware/pipeline.js';
import { callerIpIdForAddress } from '../../lib/redis/index.js';
import { catalogListIpRateLimit } from './domain/rate-limit.js';
import { MODELS_ROUTE_POSTURES, createModelsManifest } from './index.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/**
 * The public catalog list is unauthenticated and costs a Postgres read per
 * request, so the window in front of it is what bounds an anonymous flood.
 * Only a request through the assembled pipeline proves the declaration is
 * spent, so the app here is the manifest behind `applyPipeline` with this
 * slice's posture fragment wired — the same composition the Worker runs.
 *
 * The cap-sized run points `DATABASE_URL` at a closed port, so each admitted
 * request answers 503 without a catalog read and the loop measures the window
 * rather than Postgres. The limiter runs ahead of the handler, so consumption
 * is unaffected — the 429 at cap+1 under a dead database is itself the proof
 * of that ordering. A single request on the live database keeps the admitted
 * 200 path covered.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`models rate-limit tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

/** Closed port: the handler fails fast instead of reading the catalog. */
const deadDbEnv: Bindings & TelemetryEnv = {
  ...testEnv,
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
};

const redis = new Redis({
  url: testEnv.UPSTASH_REDIS_REST_URL,
  token: testEnv.UPSTASH_REDIS_REST_TOKEN,
});

const keysToClean: string[] = [];

afterAll(async () => {
  for (const key of keysToClean) await redis.del(key);
});

/** A fresh address per test, so no window here is one another test spends. */
async function freshAddress(): Promise<string> {
  const address = `198.51.100.${String(Math.floor(Math.random() * 255))}-${crypto.randomUUID()}`;
  keysToClean.push(
    rateLimitKey(catalogListIpRateLimit, await callerIpIdForAddress(address))._unsafeUnwrap()
  );
  return address;
}

function createApp(): Hono<AppEnv> {
  const manifest = createModelsManifest();
  const app = applyPipeline(new Hono<AppEnv>(), {
    rateLimit: { postures: MODELS_ROUTE_POSTURES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

describe('GET /models per-IP throttle', () => {
  it('refuses the request past the cap from one address', async () => {
    const app = createApp();
    const headers = { 'cf-connecting-ip': await freshAddress() };

    for (let attempt = 0; attempt < catalogListIpRateLimit.maxAttempts; attempt += 1) {
      const admitted = await app.request('/models', { headers }, deadDbEnv);
      expect(admitted.status).toBe(503);
    }

    const refused = await app.request('/models', { headers }, deadDbEnv);
    expect(refused.status).toBe(429);
  });

  it('admits a catalog read below the cap', async () => {
    const app = createApp();
    const headers = { 'cf-connecting-ip': await freshAddress() };

    const admitted = await app.request('/models', { headers }, testEnv);

    expect(admitted.status).toBe(200);
  });
});
