import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { ERROR_CODES, modelsListResponseSchema } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { applyPipeline } from '../../middleware/pipeline.js';
import { ROUTE_CACHE_POLICIES } from '../../composition/route-cache-policy.js';
import { cacheDirectives } from '../../lib/cache-policy/index.js';
import { listModels } from './domain/catalog/list-models.js';
import { createModelsManifest } from './index.js';
import type { ModelsListResponse } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields, Telemetry, TelemetryEnv } from '../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_REST_* are required for models route integration tests'
  );
}

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per test run so repeated runs against one database never collide. */
const RUN_PREFIX = `mdl-rt-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

interface SeedOverrides {
  readonly outputs?: string[];
  readonly pricing?: Record<string, unknown>;
  readonly limits?: Record<string, number>;
  readonly zdrReachable?: boolean;
  readonly releasedAt?: number;
}

/** Insert one wire-form descriptor row (NanoUSD string rates, jsonb). */
async function seedDescriptor(modelId: string, overrides: SeedOverrides = {}): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: RUN_PREFIX,
        version: '3',
        inputs: ['text'],
        outputs: overrides.outputs ?? ['text'],
        parameters: {},
        behaviors: [],
        limits: overrides.limits ?? { contextLength: 128_000 },
        pricing: overrides.pricing ?? {
          kind: 'tokens',
          anchor: { base: { input: '100', output: '200' }, tiers: [] },
        },
        zdrReachable: overrides.zdrReachable ?? true,
        // The default leaves the premium-recency leg unfired for every seeded
        // row, so a row overridden to the wall clock is the only recency
        // premium in the list.
        releasedAt: overrides.releasedAt ?? OLD_RELEASE_SECONDS,
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

async function fetchList(): Promise<ModelsListResponse> {
  const res = await createApp().request('/models', {}, testEnv);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  // The wire body carries exactly the shared contract's two keys.
  expect(
    Object.keys(body as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))
  ).toEqual(['models', 'premiumModelIds']);
  return modelsListResponseSchema.parse(body);
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

/**
 * Derived from the declaration the stage renders rather than written out: a
 * literal here would be one more place the tag has to agree, which is the
 * drift `CODE-RULES.md` §One Implementation, Shared bans.
 */
const DECLARED_CACHE_TAG = cacheDirectives(ROUTE_CACHE_POLICIES['$get /models']).cacheTag;

describe('GET /models (public)', () => {
  it('serves the exposed catalog to an unauthenticated caller in the shared shape', async () => {
    const exposed = freshModelId('exposed');
    await seedDescriptor(exposed);
    const body = await fetchList();
    const model = body.models.find((entry) => entry.id === exposed);
    expect(model).toBeDefined();
    expect(model?.modality).toBe('text');
    expect(model?.contextLength).toBe(128_000);
    // Billable nano rate, verbatim from the seeded descriptor — the wire
    // projection applies no fee on top of the one the catalog baked.
    expect(model?.pricing.inputPerToken).toBe('100');
  });

  it('never lists a ZDR-unreachable or unpriced model', async () => {
    const exposed = freshModelId('mixed-exposed');
    const zdrHidden = freshModelId('mixed-no-zdr');
    const unpriced = freshModelId('mixed-unpriced');
    await seedDescriptor(exposed);
    await seedDescriptor(zdrHidden, { zdrReachable: false });
    await seedDescriptor(unpriced, { pricing: {} });
    const body = await fetchList();
    const ids = body.models.map((entry) => entry.id);
    expect(ids).toContain(exposed);
    expect(ids).not.toContain(zdrHidden);
    expect(ids).not.toContain(unpriced);
    expect(body.premiumModelIds).not.toContain(zdrHidden);
    expect(body.premiumModelIds).not.toContain(unpriced);
  });

  it('classifies recent text models and media models premium', async () => {
    const recent = freshModelId('recent');
    const image = freshModelId('image');
    await seedDescriptor(recent, { releasedAt: Math.floor(Date.now() / 1000) - 1000 });
    await seedDescriptor(image, {
      outputs: ['image'],
      pricing: { kind: 'perImage', anchor: '40000000', dearest: '40000000' },
      limits: {},
    });
    const body = await fetchList();
    expect(body.premiumModelIds).toContain(recent);
    expect(body.premiumModelIds).toContain(image);
    expect(body.models.some((entry) => entry.id === image)).toBe(true);
  });

  it('hides an exposed descriptor whose wire projection fails, silently', async () => {
    // Exposed by every listDescriptors gate (ZDR, priced, language family)
    // but unprojectable: a text model without a context length fails the
    // shared modelSchema refine, so the list drops it. Silently, because the
    // condition is permanent and the served list is read once per visitor —
    // the catalog refresh's health audit is what reports it.
    const unprojectable = freshModelId('no-context');
    await seedDescriptor(unprojectable, { limits: {} });
    const errors: { msg: string; fields: SafeLogFields | undefined }[] = [];
    const telemetry: Telemetry = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, fields?: SafeLogFields) => {
        errors.push({ msg, fields });
      },
      captureError: () => {},
    };
    const result = await listModels({ db, telemetry }, Date.now());
    const response = result._unsafeUnwrap();
    expect(response.models.some((entry) => entry.id === unprojectable)).toBe(false);
    expect(errors.filter((line) => line.fields?.modelName === unprojectable)).toEqual([]);
  });

  it('declares shared cacheability on the served catalog', async () => {
    const res = await createApp().request('/models', {}, testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60');
    expect(res.headers.get('Cache-Tag')).toBe(DECLARED_CACHE_TAG);
  });

  it('answers 503 when the database is unreachable', async () => {
    const deadDbEnv = {
      ...testEnv,
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
    };
    const res = await createApp().request('/models', {}, deadDbEnv);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});
