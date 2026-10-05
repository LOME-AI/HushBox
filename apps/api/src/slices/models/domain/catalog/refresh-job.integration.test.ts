import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  jsonResponse,
  modelEntryFixture,
  routedFetch,
} from './gateway-fixtures.js';
import { createCatalogSightingRecorder } from '../../adapters/catalog-lifecycle.js';
import { DESCRIPTOR_VERSION } from './normalize.js';
import { refreshCatalog } from './refresh.js';
import { createCatalogRefreshJobRegistration } from './refresh-job.js';
import type { JobExecution } from '../../../../lib/jobs/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { RefreshCatalogDeps } from './refresh.js';

/** A stored descriptor read back as the object it was written as. */
const StoredDescriptor = z.record(z.string(), z.unknown());
const StoredVersion = z.object({ version: z.string() });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for catalog refresh job integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const RUN_PREFIX = `mdl-rj-${crypto.randomUUID().slice(0, 8)}`;
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

const SEEN_AT = new Date(TEST_DAY_START);

function refreshDeps(fetch: typeof globalThis.fetch): RefreshCatalogDeps {
  return {
    db,
    fetch,
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: silentTelemetry,
    now: () => SEEN_AT,
    recordSighting: createCatalogSightingRecorder(db),
  };
}

function languageFetch(modelIds: readonly string[]): typeof globalThis.fetch {
  return catalogFetch({
    models: modelIds.map((id) => modelEntryFixture({ id })),
    zdrModelIds: modelIds,
  });
}

function executionFor(descriptorVersion: string): JobExecution<{ descriptorVersion: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload: { descriptorVersion },
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

async function storedVersions(modelIds: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [...modelIds]));
  return rows.map((row) => StoredVersion.parse(row.descriptor).version);
}

/** Rows a refresh wrote at the running version, then stamped back to an older one. */
async function seedAtVersion(modelIds: readonly string[], version: string): Promise<void> {
  const refreshed = await refreshCatalog(refreshDeps(languageFetch(modelIds)));
  refreshed._unsafeUnwrap();
  const rows = await db
    .select({ modelId: modelCatalog.modelId, descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [...modelIds]));
  for (const row of rows) {
    await db
      .update(modelCatalog)
      .set({ descriptor: { ...StoredDescriptor.parse(row.descriptor), version } })
      .where(inArray(modelCatalog.modelId, [row.modelId]));
  }
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('the catalog.refresh.v1 handler', () => {
  it('rewrites every row at an older descriptor version whose content is otherwise unchanged', async () => {
    const modelIds = [freshModelId('older-a'), freshModelId('older-b')];
    await seedAtVersion(modelIds, '2');
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps(languageFetch(modelIds)),
    });

    const outcome = await registration.handler(executionFor(DESCRIPTOR_VERSION));

    expect(outcome.kind).toBe('ok');
    expect(await storedVersions(modelIds)).toEqual([DESCRIPTOR_VERSION, DESCRIPTOR_VERSION]);
  });

  it('reports what the refresh wrote', async () => {
    const modelId = freshModelId('older-summary');
    await seedAtVersion([modelId], '2');
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () => refreshDeps(languageFetch([modelId])),
    });

    const outcome = await registration.handler(executionFor(DESCRIPTOR_VERSION));

    expect(outcome).toEqual({
      kind: 'ok',
      result: { written: 1, unchanged: 0, excluded: 0 },
    });
  });

  it('fails with the refresh error code when the gateway cannot be read, so the row retries', async () => {
    const registration = createCatalogRefreshJobRegistration({
      resolveRefresh: () =>
        refreshDeps(routedFetch({ models: () => jsonResponse({ error: 'down' }, 503) })),
    });

    const outcome = await registration.handler(executionFor(DESCRIPTOR_VERSION));

    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
  });
});
