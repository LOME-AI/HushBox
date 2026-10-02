import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb, publicStatsSnapshots } from '@hushbox/db';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { unavailableError } from '../../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { createPublicStatsStores } from '../../adapters/public-stats-stores.js';
import {
  createCatalogModelMetaResolver,
  createPublicStatsSnapshotEntry,
  modelMetaFromDescriptors,
} from './public-stats-snapshot-entry.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { PublicStatsModelMeta } from './public-usage-stats.js';
import type { PublicStatsSnapshotRow, PublicStatsStores } from '../../ports/public-stats.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for public-stats-snapshot-entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const realStores = createPublicStatsStores();
const createdSnapshotIds: string[] = [];

afterAll(async () => {
  if (createdSnapshotIds.length > 0) {
    await db
      .delete(publicStatsSnapshots)
      .where(inArray(publicStatsSnapshots.id, createdSnapshotIds));
  }
  await db.$client.end();
});

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

const NOW = new Date(TEST_DAY_START + 3 * HOUR_MS);

interface StoresHarness {
  readonly stores: PublicStatsStores;
  readonly inserted: PublicStatsSnapshotRow[];
}

/**
 * The snapshot write is the real store against the real database, so the
 * insert statement, the table's constraints and its defaults are all
 * exercised. Only the aggregate reads are faked: they are GLOBAL (unscoped)
 * over `usage_records`, so real ones would see rows other test files write
 * concurrently and the built payload would stop being deterministic.
 */
function storesWithRealWrite(overrides?: Partial<PublicStatsStores>): StoresHarness {
  const inserted: StoresHarness['inserted'] = [];
  const stores: PublicStatsStores = {
    aggregateGlobalUsageByModel: () => okAsync([]),
    readGlobalCostPercentiles: () => okAsync(null),
    readGlobalTrendCounts: () => okAsync([]),
    insertPublicStatsSnapshot: (database, input) =>
      realStores.insertPublicStatsSnapshot(database, input).map((row) => {
        inserted.push(row);
        createdSnapshotIds.push(row.id);
        return row;
      }),
    readLatestPublicStatsSnapshot: (database, schemaVersion) =>
      realStores.readLatestPublicStatsSnapshot(database, schemaVersion),
    ...overrides,
  };
  return { stores, inserted };
}

function entryWith(harness: StoresHarness): ReturnType<typeof createPublicStatsSnapshotEntry> {
  return createPublicStatsSnapshotEntry({
    db,
    stores: harness.stores,
    now: () => NOW,
    resolveModelMeta: () => okAsync(new Map()),
  });
}

function descriptorFixture(overrides: Partial<ModelDescriptor> & { id: string }): ModelDescriptor {
  return {
    provider: overrides.id.split('/')[0] ?? 'prov',
    version: '3',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1000n, output: 1000n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: FIXTURE_STAMP_SECONDS,
    ...overrides,
  };
}

describe('createPublicStatsSnapshotEntry', () => {
  it('names the entry public-stats-snapshot', () => {
    expect(entryWith(storesWithRealWrite()).name).toBe('public-stats-snapshot');
  });

  it('persists the built payload as one snapshot row on success', async () => {
    const harness = storesWithRealWrite();
    await expect(entryWith(harness).run()).resolves.toBeUndefined();
    expect(harness.inserted).toHaveLength(1);
    const id = harness.inserted[0]?.id;
    if (id === undefined) throw new Error('the snapshot store returned no row');

    const rows = await db
      .select({
        schemaVersion: publicStatsSnapshots.schemaVersion,
        stats: publicStatsSnapshots.stats,
      })
      .from(publicStatsSnapshots)
      .where(eq(publicStatsSnapshots.id, id));
    expect(rows[0]?.schemaVersion).toBe(PUBLIC_USAGE_STATS_SCHEMA_VERSION);
    expect(rows[0]?.stats).toEqual({
      schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
      generatedAt: NOW.toISOString(),
      modalities: {},
    });
  });

  it('propagates a build failure to the throw channel without inserting', async () => {
    const harness = storesWithRealWrite({
      aggregateGlobalUsageByModel: () => errAsync(unavailableError('aggregate query failed')),
    });
    await expect(entryWith(harness).run()).rejects.toThrow('unavailable');
    expect(harness.inserted).toHaveLength(0);
  });

  it('propagates a snapshot insert failure to the throw channel', async () => {
    const harness = storesWithRealWrite({
      insertPublicStatsSnapshot: () => errAsync(unavailableError('snapshot insert failed')),
    });
    await expect(entryWith(harness).run()).rejects.toThrow('unavailable');
  });
});

describe('createPublicStatsSnapshotEntry across two writes', () => {
  // A private schema version per run keeps the latest-snapshot read on this
  // test's own rows: other test files write snapshots to the global table.
  const privateVersion = 2_000_000 + Math.floor(Math.random() * 1_000_000);
  const modelId = `pss-${crypto.randomUUID()}/model`;

  function privateStores(): StoresHarness {
    return storesWithRealWrite({
      aggregateGlobalUsageByModel: (_database, query) =>
        okAsync(
          query.modality === 'text' ? [{ modelId, messageCount: 10, costNanoUsd: 10_000_000n }] : []
        ),
      readGlobalCostPercentiles: () => okAsync({ medianNanoUsd: 1_000_000, p90NanoUsd: 1_000_000 }),
      insertPublicStatsSnapshot: (database, input) =>
        realStores
          .insertPublicStatsSnapshot(database, { ...input, schemaVersion: privateVersion })
          .map((row) => {
            createdSnapshotIds.push(row.id);
            return row;
          }),
      readLatestPublicStatsSnapshot: (database) =>
        realStores.readLatestPublicStatsSnapshot(database, privateVersion),
    });
  }

  async function writeWith(catalog: ReadonlyMap<string, PublicStatsModelMeta>): Promise<unknown> {
    await createPublicStatsSnapshotEntry({
      db,
      stores: privateStores().stores,
      now: () => NOW,
      resolveModelMeta: () => okAsync(catalog),
    }).run();
    const latest = await realStores.readLatestPublicStatsSnapshot(db, privateVersion);
    return latest._unsafeUnwrap()?.stats;
  }

  it('keeps the name of a model the catalog drops between the writes', async () => {
    await writeWith(new Map([[modelId, { displayName: 'Kept Name', provider: 'Kept Lab' }]]));
    const second = await writeWith(new Map());
    expect(second).toMatchObject({
      modalities: {
        text: {
          '7d': { models: [{ modelId, displayName: 'Kept Name', provider: 'Kept Lab' }] },
        },
      },
    });
  });
});

describe('modelMetaFromDescriptors', () => {
  it('maps requested ids to display meta with the raw id as the name fallback', () => {
    const descriptors = [
      descriptorFixture({ id: 'prov/named', name: 'Named Model' }),
      descriptorFixture({ id: 'prov/unnamed' }),
      descriptorFixture({ id: 'prov/unrequested', name: 'Skipped' }),
    ];
    const meta = modelMetaFromDescriptors(descriptors, [
      'prov/named',
      'prov/unnamed',
      'prov/absent',
    ]);
    expect(meta.get('prov/named')).toEqual({ displayName: 'Named Model', provider: 'prov' });
    expect(meta.get('prov/unnamed')).toEqual({ displayName: 'prov/unnamed', provider: 'prov' });
    expect(meta.has('prov/unrequested')).toBe(false);
    expect(meta.has('prov/absent')).toBe(false);
  });
});

describe('createCatalogModelMetaResolver', () => {
  it('reads the live catalog and omits ids the catalog does not expose', async () => {
    const resolver = createCatalogModelMetaResolver({ db, telemetry: silentTelemetry });
    const unknownId = `pss-${crypto.randomUUID()}/absent`;
    const resolved = await resolver([unknownId]);
    expect(resolved._unsafeUnwrap().has(unknownId)).toBe(false);
  });
});
