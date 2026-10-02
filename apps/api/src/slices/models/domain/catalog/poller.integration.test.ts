import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { TEST_GATEWAY_BASE_URL, catalogFetch, modelEntryFixture } from './gateway-fixtures.js';
import { createCatalogSightingRecorder } from '../../index.js';
import {
  CATALOG_REFRESH_JITTER_MAX_MS,
  createCatalogRefreshEntry,
  productionRefreshJitter,
} from './poller.js';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';
import type { CronEntry } from '../../../../lib/jobs/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for poller entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

function recordingTelemetry(warns: RecordedLine[]): Telemetry {
  return {
    ...silentTelemetry,
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
  };
}

/** Unique per test run so repeated runs against one database never collide. */
const RUN_PREFIX = `pol-cat-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

/** A catalog poller over one language model, with the gateway's retention list
 * supplied by the caller so a run can be made to see none of it. */
function catalogEntryFor(
  modelId: string,
  zdrModelIds: readonly string[],
  telemetry: Telemetry
): CronEntry {
  return createCatalogRefreshEntry({
    db,
    telemetry,
    now: () => new Date(),
    recordSighting: createCatalogSightingRecorder(db),
    fetch: catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds }),
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
  });
}

async function excludedReasonFor(modelId: string): Promise<string | null | undefined> {
  const rows = await db
    .select()
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [modelId]));
  return rows[0]?.excludedReason;
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('createCatalogRefreshEntry', () => {
  it('runs the catalog refresh against the configured gateway', async () => {
    const sleeps: number[] = [];
    const entry = createCatalogRefreshEntry({
      db,
      telemetry: silentTelemetry,
      now: () => new Date(),
      recordSighting: createCatalogSightingRecorder(db),
      fetch: catalogFetch({ models: [], zdrModelIds: [] }),
      gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
      jitter: {
        maxMs: CATALOG_REFRESH_JITTER_MAX_MS,
        random: () => 0.5,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    expect(entry.name).toBe('model-catalog-refresh');
    await entry.run();
    // The jitter spreads a fleet of triggers; half of the 60s ceiling here.
    expect(sleeps).toEqual([CATALOG_REFRESH_JITTER_MAX_MS / 2]);
  });

  it('alerts once when an empty retention list newly excludes the models it was selling', async () => {
    const modelId = freshModelId('retention-blackout');
    await catalogEntryFor(modelId, [modelId], silentTelemetry).run();
    expect(await excludedReasonFor(modelId)).toBeNull();

    const warns: RecordedLine[] = [];
    await catalogEntryFor(modelId, [], recordingTelemetry(warns)).run();

    expect(warns).toEqual([
      {
        msg: 'gateway retention list excluded every discovered model — nothing is sellable',
        fields: { droppedCount: 1, errorCode: 'model_catalog_retention_list_empty' },
      },
    ]);
    // The alert watches the write; it never blocks it.
    expect(await excludedReasonFor(modelId)).toBe('non-zdr');
  });

  it('propagates a refresh failure to the entry runner', async () => {
    const entry = createCatalogRefreshEntry({
      db,
      telemetry: silentTelemetry,
      now: () => new Date(),
      recordSighting: createCatalogSightingRecorder(db),
      fetch: () => Promise.reject(new Error('gateway unreachable')),
      gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
      jitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
    });
    await expect(entry.run()).rejects.toThrow();
  });
});

describe('productionRefreshJitter', () => {
  it('spreads starts across the sixty-second ceiling', async () => {
    const jitter = productionRefreshJitter();
    expect(jitter.maxMs).toBe(60_000);
    const sample = jitter.random();
    expect(sample).toBeGreaterThanOrEqual(0);
    expect(sample).toBeLessThan(1);
    await expect(jitter.sleep(1)).resolves.toBeUndefined();
  });
});
