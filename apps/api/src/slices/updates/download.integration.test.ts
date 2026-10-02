import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { cacheDirectives } from '../../lib/cache-policy/index.js';
import { createUpdatesManifest } from './routes.js';
import {
  appBuildObjectUrl,
  appBuildsS3,
  minioBuildsBucket,
} from '../../test-support/app-builds-bucket.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { AppBuildsBucket } from './index.js';

/**
 * The download route's behavior, proven against a real object store rather
 * than an in-memory stub wherever the bytes are the subject.
 *
 * Every case here runs behind `applyPipeline`, the same composition the Worker
 * runs, which is what moved the binding and key-shape cases here from the
 * slice's unit suite. No posture map is wired, so nothing here spends the
 * route's per-IP window; that window is measured in
 * `routes-rate-limit.integration.test.ts`, which wires the slice's fragment.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`updates download tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

interface DownloadEnv extends Bindings, TelemetryEnv {
  APP_VERSION: string;
  APP_BUILDS?: AppBuildsBucket | undefined;
}

const testEnv: DownloadEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  APP_VERSION: 'dev-local',
  APP_BUILDS: minioBuildsBucket(),
};

function buildApp(): Hono<AppEnv> {
  const manifest = createUpdatesManifest();
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/**
 * A fresh address per request, so no case here shares a caller identity with
 * another case or another file — the identity a per-IP window keys on is
 * shared by every caller presenting the same address.
 */
async function get(path: string, env: DownloadEnv = testEnv): Promise<Response> {
  return buildApp().request(
    path,
    { headers: { 'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}` } },
    env
  );
}

/**
 * Derived from the declaration the stage renders rather than written out: a
 * literal here would be one more place the tag has to agree, which is the
 * drift `CODE-RULES.md` §One Implementation, Shared bans.
 */
const DECLARED_CACHE_TAG = cacheDirectives(
  ROUTE_CACHE_POLICIES['$get /updates/download/:platform/:version']
).cacheTag;

describe('GET /updates/download (MinIO-backed)', () => {
  it('streams an existing bundle as an immutable zip', async () => {
    const version = `1.0.0-${crypto.randomUUID().slice(0, 8)}`;
    const key = `builds/ios/${version}.zip`;
    const payload = new TextEncoder().encode(`zip-bytes-${version}`);
    const put = await appBuildsS3.fetch(appBuildObjectUrl(key), {
      method: 'PUT',
      body: payload,
      headers: { 'content-type': 'application/zip' },
    });
    expect(put.ok).toBe(true);

    try {
      const res = await get(`/updates/download/ios/${version}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-length')).toBe(String(payload.byteLength));
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
      expect(res.headers.get('cache-tag')).toBe(DECLARED_CACHE_TAG);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    } finally {
      await appBuildsS3.fetch(appBuildObjectUrl(key), { method: 'DELETE' });
    }
  });

  it('answers 404 BUILD_NOT_FOUND for a version that was never uploaded', async () => {
    const res = await get(`/updates/download/android/0.0.0-${crypto.randomUUID().slice(0, 8)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'BUILD_NOT_FOUND' });
  });

  it('rejects an invalid platform with 400 VALIDATION', async () => {
    const res = await get('/updates/download/windows/1.0.0');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('answers 404 BUILD_NOT_FOUND when the bucket binding is missing', async () => {
    const res = await get('/updates/download/ios/1.0.0', { ...testEnv, APP_BUILDS: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'BUILD_NOT_FOUND' });
  });

  it('requests the builds/<platform>/<version>.zip key', async () => {
    const keys: string[] = [];
    const bucket: AppBuildsBucket = {
      get: (key) => {
        keys.push(key);
        return Promise.resolve(null);
      },
    };
    await get('/updates/download/android-direct/2.0.0', { ...testEnv, APP_BUILDS: bucket });
    expect(keys).toEqual(['builds/android-direct/2.0.0.zip']);
  });
});
