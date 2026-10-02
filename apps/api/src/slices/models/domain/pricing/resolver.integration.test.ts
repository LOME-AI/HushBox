import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  modelEntryFixture,
} from '../catalog/gateway-fixtures.js';
import { createModelPricingResolver } from './resolver.js';
import { refreshCatalog } from '../catalog/refresh.js';
import { createCatalogSightingRecorder } from '../../adapters/catalog-lifecycle.js';
import type { ModelPricingResolver } from './estimate-run.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for pricing-resolver integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per test run so repeated runs against one database never collide. */
const RUN_PREFIX = `mdl-pr-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

async function refresh(fetch: typeof globalThis.fetch): Promise<void> {
  const result = await refreshCatalog({
    db,
    fetch,
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: silentTelemetry,
    // The ambient clock, which is also the clock the resolver's own read takes:
    // the exposure filter delists a row it has not sighted for a day.
    now: () => new Date(),
    recordSighting: createCatalogSightingRecorder(db),
  });
  result._unsafeUnwrap();
}

async function resolver(): Promise<ModelPricingResolver> {
  const result = await createModelPricingResolver({ db, telemetry: silentTelemetry });
  return result._unsafeUnwrap();
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('createModelPricingResolver', () => {
  it('resolves an exposed model id to its descriptor, pricing carried', async () => {
    const modelId = freshModelId('resolved');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );

    const resolve = await resolver();
    const descriptor = resolve(modelId);
    expect(descriptor?.id).toBe(modelId);
    expect(Object.keys(descriptor?.pricing ?? {}).length).toBeGreaterThan(0);
  });

  it('returns undefined for a model id absent from the catalog', async () => {
    const resolve = await resolver();

    expect(resolve(`${RUN_PREFIX}/never-stored`)).toBeUndefined();
  });

  it('returns undefined for a stored-but-unexposed model (fail-closed by omission)', async () => {
    // A non-ZDR model is hidden by the exposure gate, so it never becomes
    // resolvable — the resolver inherits list-descriptors' fail-closed filtering.
    const modelId = freshModelId('no-zdr');
    await refresh(catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [] }));

    const resolve = await resolver();
    expect(resolve(modelId)).toBeUndefined();
  });
});
