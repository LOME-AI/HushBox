import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { modelWeightsRoutePath } from '@hushbox/shared/model-weights';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { cacheDirectives } from '../../lib/cache-policy/index.js';
import { createModelsManifest } from '../models/index.js';
import { createModelWeightsManifest } from './routes.js';
import {
  minioModelWeightsBucket,
  publishArtifact,
  unpublishArtifact,
} from '../../test-support/model-weights-bucket.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { ModelWeightsBucket } from './index.js';

/**
 * The artifact route's behavior, proven against a real object store wherever
 * the bytes are the subject, and behind `applyPipeline` — the same composition
 * the Worker runs, which is what puts the declared cache headers on the
 * responses asserted below.
 *
 * No posture map is wired, so nothing here spends the route's per-IP window.
 *
 * Nothing here asserts a cache HIT, and nothing can: the platform cache is
 * consulted before the Worker runs and is untestable locally and in CI
 * (`docs/CACHING.md`). What is proven is the Worker's own headers.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`model-weights tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

interface ArtifactEnv extends Bindings, TelemetryEnv {
  MODEL_WEIGHTS?: ModelWeightsBucket | undefined;
}

const testEnv: ArtifactEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  MODEL_WEIGHTS: minioModelWeightsBucket(),
};

function buildApp(): Hono<AppEnv> {
  const manifest = createModelWeightsManifest();
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
async function get(path: string, env: ArtifactEnv = testEnv): Promise<Response> {
  return buildApp().request(
    path,
    { headers: { 'cf-connecting-ip': `203.0.113.7-${crypto.randomUUID()}` } },
    env
  );
}

/** A bucket that answers nothing and records what the route asked it for. */
function recordingBucket(keys: string[]): ModelWeightsBucket {
  return {
    get: (key) => {
      keys.push(key);
      return Promise.resolve(null);
    },
  };
}

/**
 * Derived from the declaration the stage renders rather than written out: a
 * literal here would be one more place the tag has to agree, which is the
 * drift `CODE-RULES.md` §One Implementation, Shared bans.
 */
const DECLARED_CACHE_TAG = cacheDirectives(
  ROUTE_CACHE_POLICIES['$get /models/:model/:version/:file']
).cacheTag;

const MODEL = `smollm2-${crypto.randomUUID().slice(0, 8)}`;
const VERSION = '2026-08-31';
const WEIGHTS = 'model_quantized.onnx';
const CONFIG = 'config.json';
const WEIGHTS_BYTES = new TextEncoder().encode(`onnx-bytes-${MODEL}`);
const CONFIG_BYTES = new TextEncoder().encode('{"model_type":"llama"}');

const keyOf = (file: string): string => `models/${MODEL}/${VERSION}/${file}`;

beforeAll(async () => {
  await publishArtifact(keyOf(WEIGHTS), WEIGHTS_BYTES);
  await publishArtifact(keyOf(CONFIG), CONFIG_BYTES);
});

afterAll(async () => {
  await unpublishArtifact(keyOf(WEIGHTS));
  await unpublishArtifact(keyOf(CONFIG));
});

describe('GET /models/:model/:version/:file (MinIO-backed)', () => {
  it('streams a published artifact as immutable opaque bytes', async () => {
    const res = await get(`/models/${MODEL}/${VERSION}/${WEIGHTS}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(WEIGHTS_BYTES.byteLength));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('cache-tag')).toBe(DECLARED_CACHE_TAG);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEIGHTS_BYTES);
  });

  it('streams a .json artifact as json', async () => {
    const res = await get(`/models/${MODEL}/${VERSION}/${CONFIG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CONFIG_BYTES);
  });

  it('answers 404 NOT_FOUND for a model nothing published', async () => {
    const res = await get(
      `/models/absent-${crypto.randomUUID().slice(0, 8)}/${VERSION}/${WEIGHTS}`
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('answers 404 NOT_FOUND for a version nothing published', async () => {
    const res = await get(`/models/${MODEL}/1999-01-01/${WEIGHTS}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('answers 404 NOT_FOUND for a file nothing published', async () => {
    const res = await get(`/models/${MODEL}/${VERSION}/absent.onnx`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('answers 404 NOT_FOUND when the bucket binding is missing', async () => {
    const res = await get(`/models/${MODEL}/${VERSION}/${WEIGHTS}`, {
      ...testEnv,
      MODEL_WEIGHTS: undefined,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('leaves a 404 unstorable, since only the 200 is the immutable body', async () => {
    const res = await get(`/models/${MODEL}/${VERSION}/absent.onnx`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('requests the models/<model>/<version>/<file> key', async () => {
    const keys: string[] = [];
    await get(`/models/${MODEL}/${VERSION}/${WEIGHTS}`, {
      ...testEnv,
      MODEL_WEIGHTS: recordingBucket(keys),
    });
    expect(keys).toEqual([keyOf(WEIGHTS)]);
  });
});

/**
 * The `:file` segment is the one caller-supplied value that reaches an object
 * key, so each shape below is asserted to be refused BEFORE any storage call —
 * the recording bucket is what makes "before" observable rather than implied.
 * Hono decodes a percent-escaped path parameter, so `..%2F` and `%2e%2e%2f`
 * reach the validator as the traversal they encode; a path holding a literal
 * `..` segment is normalized away by the URL parser and never matches at all.
 */
describe('path traversal on the :file segment', () => {
  it.each([
    ['an encoded relative escape', '..%2Fsecret'],
    ['a fully encoded relative escape', '%2e%2e%2fsecret'],
    ['an encoded absolute path', '%2Fetc%2Fpasswd'],
    ['an encoded nested path', 'onnx%2Fmodel.onnx'],
    ['an encoded backslash escape', '..%5Csecret'],
    ['a literal parent-directory segment', '../secret'],
    ['a parent-directory hop inside a name', 'model..onnx'],
    ['a leading dot', '.hidden'],
  ])('refuses %s without reaching storage', async (_case, file) => {
    const keys: string[] = [];
    const res = await get(`/models/${MODEL}/${VERSION}/${file}`, {
      ...testEnv,
      MODEL_WEIGHTS: recordingBucket(keys),
    });
    expect(res.status).not.toBe(200);
    expect(keys).toEqual([]);
  });

  it('answers a rejected file segment with the uniform validation body', async () => {
    const res = await get(`/models/${MODEL}/${VERSION}/..%2Fsecret`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a traversal in the model segment without reaching storage', async () => {
    const keys: string[] = [];
    const res = await get(`/models/..%2Fsecret/${VERSION}/${WEIGHTS}`, {
      ...testEnv,
      MODEL_WEIGHTS: recordingBucket(keys),
    });
    expect(res.status).toBe(400);
    expect(keys).toEqual([]);
  });

  it('refuses a traversal in the version segment without reaching storage', async () => {
    const keys: string[] = [];
    const res = await get(`/models/${MODEL}/..%2Fsecret/${WEIGHTS}`, {
      ...testEnv,
      MODEL_WEIGHTS: recordingBucket(keys),
    });
    expect(res.status).toBe(400);
    expect(keys).toEqual([]);
  });
});

/**
 * This slice and the catalog slice share the `/models` mount, so the one thing
 * a reader cannot take on faith is that the parameterised route does not
 * swallow the catalog's own path. Mounted together here, `GET /models` must
 * reach the catalog — proven by this slice's bucket recording nothing, which
 * is the only evidence available without a database behind the catalog read.
 */
describe('the shared /models mount', () => {
  it('leaves GET /models to the catalog slice', async () => {
    const keys: string[] = [];
    const catalog = createModelsManifest();
    const artifacts = createModelWeightsManifest();
    const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: ROUTE_CACHE_POLICIES } });
    app.route(catalog.basePath, catalog.routes);
    app.route(artifacts.basePath, artifacts.routes);
    await app.request(
      '/models',
      { headers: { 'cf-connecting-ip': `203.0.113.7-${crypto.randomUUID()}` } },
      { ...testEnv, MODEL_WEIGHTS: recordingBucket(keys) }
    );
    expect(keys).toEqual([]);
  });
});

/**
 * The loaders address these objects through the shared URL builder, whose path
 * shape belongs to this route. Nothing else compares the two: the builder's own
 * unit test pins the string it returns, and a route moved out from under it
 * would leave that test green while every loader 404s for the life of a version
 * — silently, because the features these objects serve degrade without a sound.
 */
describe('the shared URL builder against the mounted route', () => {
  it('names a path this route answers', async () => {
    const res = await get(modelWeightsRoutePath(MODEL, VERSION, WEIGHTS));
    expect(res.status).toBe(200);
  });
});
