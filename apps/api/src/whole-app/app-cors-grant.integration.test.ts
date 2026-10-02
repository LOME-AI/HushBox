import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION } from '@hushbox/shared';
import { createApp } from '../app.js';
import {
  appBuildObjectUrl,
  appBuildsS3,
  minioBuildsBucket,
} from '../test-support/app-builds-bucket.js';
import {
  minioModelWeightsBucket,
  publishArtifact,
  unpublishArtifact,
} from '../test-support/model-weights-bucket.js';
import { cors } from '../middleware/cors.js';
import { markPipelineHandler } from '../middleware/pipeline-markers.js';
import { applyPipeline } from '../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../composition/route-cache-policy.js';
import { okAsync } from '../lib/result/index.js';
import {
  createAnnouncementsManifest,
  createAnnouncementsStores,
} from '../slices/announcements/index.js';
import { createRoadmapManifest } from '../slices/roadmap/index.js';
import { MOCK_ISSUES, MOCK_PROJECTS } from '../slices/roadmap/adapters/mock-roadmap-fixture.js';
import { createModelsManifest } from '../slices/models/index.js';
import { createStatsManifest } from '../slices/stats/index.js';
import { createUpdatesManifest } from '../slices/updates/index.js';
import type { PublicUsageStats } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';
import type { LinearClient, LinearRoadmapData } from '../slices/roadmap/ports/index.js';
import type { PublicStatsStores } from '../slices/billing/index.js';
import type { ModelWeightsBucket } from '../slices/model-weights/index.js';

/**
 * The wildcard grant read off LIVE routes rather than off test doubles.
 * `middleware/cors.ts` grants `Access-Control-Allow-Origin: *` to a
 * `public`-classed route only when the response it produced carries both
 * `Cache-Control: public` and `s-maxage`. `cors.test.ts` pins the predicate
 * against doubles it owns, so it stays green when a real route stops
 * satisfying it — dropping `s-maxage` while tuning a CDN would silently
 * revoke a live cross-origin grant. These tests fail in that case.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the CORS grant integration tests`);
  }
  return value;
}

const testEnv: Bindings &
  TelemetryEnv & {
    APP_VERSION: string;
    FRONTEND_URL: string;
    MARKETING_URL: string;
    FRONTEND_PREVIEW_URL: string;
  } = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  APP_VERSION: '1.0.0',
  // CORS fail-fasts on absent web origins, so the allowlist must be resolvable.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

/** No allowlisted origin may be used: the wildcard branch is the one under test. */
const FOREIGN_ORIGIN = 'https://evil.example';

const snapshotStats: PublicUsageStats = {
  schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  modalities: {},
};

/**
 * The stats route's declared test seam. Only the read it performs is live;
 * every other member throws if reached, so the route cannot pass by taking a
 * path this test did not intend.
 */
function statsStores(): PublicStatsStores {
  const unreachable = (): never => {
    throw new Error('unreachable store member for GET /public/stats');
  };
  return {
    aggregateGlobalUsageByModel: unreachable,
    readGlobalCostPercentiles: unreachable,
    readGlobalTrendCounts: unreachable,
    insertPublicStatsSnapshot: unreachable,
    readLatestPublicStatsSnapshot: () =>
      okAsync({
        id: crypto.randomUUID(),
        schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
        stats: snapshotStats,
        createdAt: new Date(),
      }),
  };
}

/** The roadmap route's declared Linear seam, backed by the committed fixture. */
const linearClient: LinearClient = {
  fetchRoadmap: (): Promise<LinearRoadmapData> =>
    Promise.resolve({ projects: MOCK_PROJECTS, issues: MOCK_ISSUES }),
};

/**
 * The real manifests under the real edge order — `cors()` ahead of the
 * pipeline, both marked pipeline-owned, exactly as the composition root
 * mounts them.
 */
function buildApp(): Hono<AppEnv> {
  const root = new Hono<AppEnv>();
  root.use('*', markPipelineHandler(cors()));
  const app = applyPipeline(root, { cache: { policies: ROUTE_CACHE_POLICIES } });
  const manifests = [
    createAnnouncementsManifest({ stores: createAnnouncementsStores }),
    createStatsManifest({ stores: statsStores() }),
    createRoadmapManifest({ linear: () => linearClient, teamKey: uniqueId('team') }),
    createUpdatesManifest(),
    createModelsManifest(),
  ];
  for (const manifest of manifests) app.route(manifest.basePath, manifest.routes);
  return app;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

/** A fresh IP per call so the per-IP throttles never couple these tests. */
async function getCrossOrigin(path: string): Promise<Response> {
  return buildApp().request(
    path,
    {
      headers: {
        Origin: FOREIGN_ORIGIN,
        'cf-connecting-ip': `203.0.113.7-${crypto.randomUUID()}`,
      },
    },
    testEnv
  );
}

describe('cross-origin grant on the live shared-cacheable routes', () => {
  it.each(['/announcements/banner', '/public/stats', '/public/roadmap', '/models'])(
    'grants the wildcard to a foreign origin on %s',
    async (path) => {
      const res = await getCrossOrigin(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  );

  it("keeps the credentialed echo for the app's own origin on /models", async () => {
    // The other direction of the same grant. Widening a route to the wildcard
    // is only safe while the allowlist branch still answers the app: browsers
    // hard-reject `*` on a credentialed request, so an app origin that started
    // receiving the wildcard would lose the catalog entirely, and a foreign-
    // origin assertion alone cannot see that.
    const res = await buildApp().request(
      '/models',
      {
        headers: {
          Origin: testEnv.FRONTEND_URL,
          'cf-connecting-ip': `203.0.113.23-${crypto.randomUUID()}`,
        },
      },
      testEnv
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(testEnv.FRONTEND_URL);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('withholds the wildcard from a live route whose body varies with the caller', async () => {
    // `GET /updates/current` selects its checksum from the caller's
    // `X-HushBox-Platform` header, which is why it is served `no-store` — and
    // why it must never reach a foreign origin through a shared cache.
    const res = await getCrossOrigin('/updates/current');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

/**
 * The trial-quota read goes through the composition root itself rather than a
 * locally assembled manifest: its only backing infra is Redis, which the local
 * stack provides, so no seam has to be injected and nothing about the route or
 * the edge order is restated here. A grant on this response would let any site
 * read a visitor's own remaining quota out of that visitor's browser, so the
 * withheld wildcard is the security property and the response's header set is
 * what decides it.
 */
async function getTrialRemainingCrossOrigin(): Promise<Response> {
  return createApp().request(
    '/chat/trial/remaining',
    {
      headers: {
        Origin: FOREIGN_ORIGIN,
        // Fresh per call so the route's per-IP throttle never couples runs.
        'cf-connecting-ip': `198.51.100.9-${crypto.randomUUID()}`,
        'x-trial-token': crypto.randomUUID(),
      },
    },
    testEnv
  );
}

describe('cross-origin grant on the live trial-quota read', () => {
  it('withholds the wildcard from the caller-keyed trial-quota read', async () => {
    const res = await getTrialRemainingCrossOrigin();
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('varies the trial-quota read by Origin even though the wildcard is withheld', async () => {
    // An allowlisted origin still gets the credentialed echo on this route, so
    // a cache must key on Origin whether or not the grant landed.
    const res = await getTrialRemainingCrossOrigin();
    expect(res.headers.get('Vary') ?? '').toContain('Origin');
  });
});

/**
 * The OTA bundle download also goes through the composition root. Its grant is
 * decided on the 200 path, which needs a bundle object present, so the shared
 * MinIO-backed APP_BUILDS binding stands in for the R2 bucket: the object store
 * is emulated, the route and its headers are the shipped ones. Nothing here
 * restates the route's `Cache-Control` — the download suite pins that — this
 * asserts only what the edge decides from it.
 */
async function getOtaDownloadCrossOrigin(path: string): Promise<Response> {
  return createApp().request(
    path,
    {
      headers: {
        Origin: FOREIGN_ORIGIN,
        'cf-connecting-ip': `203.0.113.11-${crypto.randomUUID()}`,
      },
    },
    { ...testEnv, APP_BUILDS: minioBuildsBucket() }
  );
}

describe('cross-origin grant on the live OTA bundle download', () => {
  it('withholds the wildcard from a served bundle whose lifetime is private-only', async () => {
    const version = `1.0.0-${crypto.randomUUID().slice(0, 8)}`;
    const key = `builds/ios/${version}.zip`;
    const put = await appBuildsS3.fetch(appBuildObjectUrl(key), {
      method: 'PUT',
      body: new TextEncoder().encode(`zip-bytes-${version}`),
      headers: { 'content-type': 'application/zip' },
    });
    expect(put.ok).toBe(true);

    try {
      const res = await getOtaDownloadCrossOrigin(`/updates/download/ios/${version}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    } finally {
      await appBuildsS3.fetch(appBuildObjectUrl(key), { method: 'DELETE' });
    }
  });
});

/**
 * The model-artifact download, the second live storable route whose grant is
 * decided on the 200 path. Its declaration is `immutable`, which writes
 * `max-age` and no `s-maxage`, so the wildcard is withheld: a private cache may
 * keep the bytes for a year, a shared one is told nothing, and the grant
 * follows the response rather than the route's `public` class. The weights are
 * fetched by the app and marketing origins, both allowlisted, so the credentialed
 * echo — not the wildcard — is the branch that has to keep answering them.
 */
async function getModelArtifactCrossOrigin(path: string): Promise<Response> {
  return createApp().request(
    path,
    {
      headers: {
        Origin: FOREIGN_ORIGIN,
        'cf-connecting-ip': `203.0.113.19-${crypto.randomUUID()}`,
      },
    },
    { ...testEnv, MODEL_WEIGHTS: minioModelWeightsBucket() satisfies ModelWeightsBucket }
  );
}

describe('cross-origin grant on the live model-artifact download', () => {
  const model = `cors-grant-${crypto.randomUUID().slice(0, 8)}`;
  const version = '2026-08-31';
  const file = 'model_quantized.onnx';
  const key = `models/${model}/${version}/${file}`;

  beforeAll(async () => {
    await publishArtifact(key, new TextEncoder().encode(`onnx-bytes-${model}`));
  });

  afterAll(async () => {
    await unpublishArtifact(key);
  });

  it('withholds the wildcard from a served artifact whose lifetime is private-only', async () => {
    const res = await getModelArtifactCrossOrigin(`/models/${model}/${version}/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it("keeps the credentialed echo for the app's own origin on a served artifact", async () => {
    const res = await createApp().request(
      `/models/${model}/${version}/${file}`,
      {
        headers: {
          Origin: testEnv.FRONTEND_URL,
          'cf-connecting-ip': `203.0.113.29-${crypto.randomUUID()}`,
        },
      },
      { ...testEnv, MODEL_WEIGHTS: minioModelWeightsBucket() satisfies ModelWeightsBucket }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(testEnv.FRONTEND_URL);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
