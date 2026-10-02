import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { unavailableError } from '../../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { modelDisplayOf } from '../../../models/index.js';
import {
  createPublicStatsSnapshotEntry,
  modelMetaFromDescriptors,
} from './public-stats-snapshot-entry.js';
import type { Database } from '@hushbox/db';
import type { ModelDescriptor, PublicUsageStats } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { PublicStatsModelMeta } from './public-usage-stats.js';
import type { PublicStatsSnapshotRow, PublicStatsStores } from '../../ports/public-stats.js';

// Every store call is faked below, so the handle is never dereferenced; the
// cast stands in for a connection this unit test must not open.
const db = {} as unknown as Database;
const NOW = new Date(TEST_DAY_START + 3 * HOUR_MS);
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);
const MODEL_ID = 'dropped/model';

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

/** A stored payload naming `MODEL_ID` in one window. */
function previousStats(displayName: string, provider: string): PublicUsageStats {
  return {
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    generatedAt: new Date(TEST_DAY_START).toISOString(),
    modalities: {
      text: {
        '7d': {
          models: [
            {
              modelId: MODEL_ID,
              displayName,
              provider,
              sharePercent: 100,
              deltaPoints: null,
              avgCostUsd: '0.001',
            },
          ],
          others: { sharePercent: 0, deltaPoints: null },
          trend: { bucket: 'day', points: [] },
          cost: { avgUsd: '0.001', medianUsd: '0.001', p90Usd: '0.001' },
        },
      },
    },
  };
}

function snapshotRow(stats: unknown): PublicStatsSnapshotRow {
  return {
    id: 'previous-snapshot',
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    stats,
    createdAt: new Date(TEST_DAY_START),
  };
}

interface Harness {
  readonly stores: PublicStatsStores;
  readonly inserted: PublicUsageStats[];
  readonly readLatest: ReturnType<typeof vi.fn>;
}

/** Stores whose every text window holds `MODEL_ID` alone, over `latest` as the stored snapshot. */
function harnessWith(
  latest: () => ResultAsync<PublicStatsSnapshotRow | null, DomainError>
): Harness {
  const inserted: PublicUsageStats[] = [];
  const readLatest = vi.fn(latest);
  const stores: PublicStatsStores = {
    aggregateGlobalUsageByModel: (_db, query) =>
      okAsync(
        query.modality === 'text'
          ? [{ modelId: MODEL_ID, messageCount: 10, costNanoUsd: 10_000_000n }]
          : []
      ),
    readGlobalCostPercentiles: () => okAsync({ medianNanoUsd: 1_000_000, p90NanoUsd: 1_000_000 }),
    readGlobalTrendCounts: () => okAsync([]),
    insertPublicStatsSnapshot: (_db, input) => {
      inserted.push(input.stats);
      return okAsync(snapshotRow(input.stats));
    },
    readLatestPublicStatsSnapshot: readLatest,
  };
  return { stores, inserted, readLatest };
}

function runEntry(
  harness: Harness,
  catalog: Record<string, PublicStatsModelMeta> = {}
): Promise<void> {
  return createPublicStatsSnapshotEntry({
    db,
    stores: harness.stores,
    now: () => NOW,
    resolveModelMeta: () => okAsync(new Map(Object.entries(catalog))),
  }).run();
}

function writtenMeta(harness: Harness): PublicStatsModelMeta {
  const model = harness.inserted[0]?.modalities.text?.['7d']?.models[0];
  if (model === undefined) throw new Error('expected one written text model');
  return { displayName: model.displayName, provider: model.provider };
}

describe('modelMetaFromDescriptors', () => {
  it('names a model as the picker does, the provider split from before the colon', () => {
    const descriptor = descriptorFixture({
      id: 'google/gemini-2.5-pro',
      provider: 'google',
      name: 'Google: Gemini 2.5 Pro',
    });
    const meta = modelMetaFromDescriptors([descriptor], [descriptor.id]).get(descriptor.id);
    expect(meta).toEqual({ displayName: 'Gemini 2.5 Pro', provider: 'Google' });
    const display = modelDisplayOf(descriptor);
    expect(meta).toEqual({ displayName: display.name, provider: display.provider });
  });
});

describe('createPublicStatsSnapshotEntry model names', () => {
  it('names a model the catalog has dropped as the latest stored snapshot did', async () => {
    const harness = harnessWith(() =>
      okAsync(snapshotRow(previousStats('Dropped Model', 'Dropped Lab')))
    );
    await runEntry(harness);
    expect(writtenMeta(harness)).toEqual({ displayName: 'Dropped Model', provider: 'Dropped Lab' });
  });

  it('keeps the raw id for a model neither the catalog nor a stored snapshot names', async () => {
    const harness = harnessWith(() => okAsync(null));
    await runEntry(harness);
    expect(writtenMeta(harness)).toEqual({ displayName: MODEL_ID, provider: MODEL_ID });
  });

  it("prefers the catalog's name over the stored snapshot's", async () => {
    const harness = harnessWith(() => okAsync(snapshotRow(previousStats('Old Name', 'Old Lab'))));
    await runEntry(harness, { [MODEL_ID]: { displayName: 'New Name', provider: 'New Lab' } });
    expect(writtenMeta(harness)).toEqual({ displayName: 'New Name', provider: 'New Lab' });
  });

  it('reads no stored snapshot when the catalog names every displayed model', async () => {
    const harness = harnessWith(() => okAsync(null));
    await runEntry(harness, { [MODEL_ID]: { displayName: 'Named', provider: 'Lab' } });
    expect(harness.readLatest).not.toHaveBeenCalled();
  });

  it('writes nothing when the stored snapshot cannot be read', async () => {
    const harness = harnessWith(() => errAsync(unavailableError('snapshot read failed')));
    await expect(runEntry(harness)).rejects.toThrow('unavailable');
    expect(harness.inserted).toHaveLength(0);
  });

  it('writes nothing when the stored snapshot fails the public schema', async () => {
    const harness = harnessWith(() => okAsync(snapshotRow({ modalities: 'corrupt' })));
    await expect(runEntry(harness)).rejects.toThrow();
    expect(harness.inserted).toHaveLength(0);
  });
});
