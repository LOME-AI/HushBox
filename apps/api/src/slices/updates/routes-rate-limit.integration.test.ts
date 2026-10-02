import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { applyPipeline } from '../../middleware/pipeline.js';
import { callerIpIdForAddress } from '../../lib/redis/index.js';
import { bundleDownloadIpRateLimit } from './domain/rate-limit.js';
import { UPDATES_ROUTE_POSTURES, createUpdatesManifest } from './index.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/**
 * The bundle download is unauthenticated, and a request naming a published
 * bundle streams the whole object out of R2, so the window in front of it is
 * what bounds an anonymous flood. Only a request through the assembled pipeline
 * proves the declaration is spent, so the app here is the manifest behind
 * `applyPipeline` with this slice's posture fragment wired — the same
 * composition the Worker runs.
 *
 * No `APP_BUILDS` binding is bound: the route then answers 404 before touching
 * any object store, which keeps a cap-sized run measuring the window rather
 * than the bucket.
 *
 * This file also carries the concurrency proof for the three unauthenticated
 * windows added alongside it. One proof covers all three because they share
 * the repo's single counting implementation; what varies between them is the
 * cap and the key, neither of which is what concurrency could break.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`updates rate-limit tests: missing ${name}. Run via a package test script.`);
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
    rateLimitKey(bundleDownloadIpRateLimit, await callerIpIdForAddress(address))._unsafeUnwrap()
  );
  return address;
}

function createApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  const app = applyPipeline(new Hono<AppEnv>(), {
    rateLimit: { postures: UPDATES_ROUTE_POSTURES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function download(app: Hono<AppEnv>, ip: string): Promise<Response> {
  return app.request(
    '/updates/download/ios/1.0.0',
    { headers: { 'cf-connecting-ip': ip } },
    testEnv
  );
}

describe('GET /updates/download/:platform/:version per-IP throttle', () => {
  it('refuses the request past the cap from one address', async () => {
    const app = createApp();
    const ip = await freshAddress();

    for (let attempt = 0; attempt < bundleDownloadIpRateLimit.maxAttempts; attempt += 1) {
      const admitted = await download(app, ip);
      expect(admitted.status).not.toBe(429);
    }

    const refused = await download(app, ip);
    expect(refused.status).toBe(429);
  });

  it('admits exactly the cap when the whole window is issued at once', async () => {
    const app = createApp();
    const ip = await freshAddress();
    const { maxAttempts } = bundleDownloadIpRateLimit;

    const responses = await Promise.all(
      Array.from({ length: maxAttempts + 1 }, () => download(app, ip))
    );

    expect(responses.filter((response) => response.status !== 429)).toHaveLength(maxAttempts);
  });
});
