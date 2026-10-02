import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import {
  appBuildObjectUrl,
  appBuildsS3,
  minioBuildsBucket,
} from '../../test-support/app-builds-bucket.js';
import { proveCallerInvariance } from '../../test-support/caller-invariance.js';
import { createUpdatesManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { AppBuildsBucket } from './index.js';

/**
 * The OTA bundle is declared storable — immutable, since a version's bytes
 * never change — which licenses replaying one caller's response to a stranger.
 * This is the proof that claim rests on; the arch rule
 * `cacheable-routes-prove-caller-invariance` requires it to exist. The bytes
 * come from the real object store, so what is compared is the streamed body a
 * cache would hold rather than a stub's.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the OTA download caller-invariance proof`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

interface DownloadEnv extends Bindings, TelemetryEnv {
  APP_VERSION: string;
  APP_BUILDS: AppBuildsBucket;
}

const testEnv: DownloadEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SESSION_SECRET,
  TELEMETRY_SINKS: 'console',
  APP_VERSION: 'dev-local',
  APP_BUILDS: minioBuildsBucket(),
};

const VERSION = `1.0.0-${crypto.randomUUID().slice(0, 8)}`;

function createApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

beforeAll(async () => {
  const put = await appBuildsS3.fetch(appBuildObjectUrl(`builds/ios/${VERSION}.zip`), {
    method: 'PUT',
    body: new TextEncoder().encode(`zip-bytes-${VERSION}`),
    headers: { 'content-type': 'application/zip' },
  });
  expect(put.ok).toBe(true);
});

describe('GET /updates/download is invariant across callers', () => {
  it('answers a session, an address, credentials and a query with identical bytes', async () => {
    await proveCallerInvariance('$get /updates/download/:platform/:version', {
      path: `/updates/download/ios/${VERSION}`,
      sessionSecret: SESSION_SECRET,
      databaseUrl: DATABASE_URL,
      // The bytes are the version's object. A per-user selection grown here
      // would arrive with a table whose row goes in this hook.
      seedIdentifiedState: () => Promise.resolve(),
      respondTo: async ({ path, headers }) => createApp().request(path, { headers }, testEnv),
    });
  });
});
