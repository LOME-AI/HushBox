import { afterAll, beforeAll, describe, it } from 'vitest';
import { Hono } from 'hono';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import {
  minioModelWeightsBucket,
  publishArtifact,
  unpublishArtifact,
} from '../../test-support/model-weights-bucket.js';
import { proveCallerInvariance } from '../../test-support/caller-invariance.js';
import { createModelWeightsManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { ModelWeightsBucket } from './index.js';

/**
 * The artifact route is declared storable — immutable, since a version's bytes
 * never change under their own URL — which licenses replaying one caller's
 * response to a stranger. This is the proof that claim rests on; the arch rule
 * `cacheable-routes-prove-caller-invariance` requires it to exist. The bytes
 * come from the real object store, so what is compared is the streamed body a
 * cache would hold rather than a stub's.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the model-artifact caller-invariance proof`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

interface ArtifactEnv extends Bindings, TelemetryEnv {
  MODEL_WEIGHTS: ModelWeightsBucket;
}

const testEnv: ArtifactEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SESSION_SECRET,
  TELEMETRY_SINKS: 'console',
  MODEL_WEIGHTS: minioModelWeightsBucket(),
};

const MODEL = `caller-inv-${crypto.randomUUID().slice(0, 8)}`;
const VERSION = '2026-08-31';
const FILE = 'model_quantized.onnx';
const KEY = `models/${MODEL}/${VERSION}/${FILE}`;

function createApp(): Hono<AppEnv> {
  const manifest = createModelWeightsManifest();
  const app = applyPipeline(new Hono<AppEnv>(), {
    cache: { policies: ROUTE_CACHE_POLICIES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

beforeAll(async () => {
  await publishArtifact(KEY, new TextEncoder().encode(`onnx-bytes-${MODEL}`));
});

afterAll(async () => {
  await unpublishArtifact(KEY);
});

describe('GET /models/:model/:version/:file is invariant across callers', () => {
  it('answers a session, an address, credentials and a query with identical bytes', async () => {
    await proveCallerInvariance('$get /models/:model/:version/:file', {
      path: `/models/${MODEL}/${VERSION}/${FILE}`,
      sessionSecret: SESSION_SECRET,
      databaseUrl: DATABASE_URL,
      // The bytes are the published object and nothing else. This slice owns no
      // table, so there is no per-user row a filter grown here could read.
      seedIdentifiedState: () => Promise.resolve(),
      respondTo: async ({ path, headers }) => createApp().request(path, { headers }, testEnv),
    });
  });
});
