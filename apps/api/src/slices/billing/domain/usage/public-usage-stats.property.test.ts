/**
 * The trend series' shape, over every sparse spread of usage a window and a
 * clock can hold: it starts at the first bucket with data, ends no later than
 * yesterday's bucket, repeats the previous point over a bucket without data,
 * and computes a bucket with data from that bucket's rows alone.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { USAGE_STATS_WINDOWS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { okAsync } from '../../../../lib/result/index.js';
import { buildPublicUsageStats } from './public-usage-stats.js';
import type { Database } from '@hushbox/db';
import type {
  PublicUsageStats,
  UsageStatsTrendBucket,
  UsageStatsWindow,
  UsageStatsWindowStats,
} from '@hushbox/shared';
import type {
  GlobalTrendCountRow,
  GlobalUsageWindowQuery,
  PublicStatsStores,
} from '../../ports/public-stats.js';

// The stores here are in memory and never touch the handle.
const db = {} as unknown as Database;

const MODEL_IDS = ['m/a', 'm/b', 'm/c', 'm/d'] as const;

/** One sparse usage entry: `count` text messages for one model at one UTC midnight. */
interface UsageEntry {
  readonly createdAtMs: number;
  readonly modelId: string;
  readonly count: number;
}

interface TrendCase {
  readonly now: Date;
  readonly entries: readonly UsageEntry[];
}

/**
 * Sparse buckets over a window and a clock. The clock ranges over the days
 * around the reference day, so month starts fall inside it, at any moment of
 * its day; entries land on UTC midnights from today back past the 30-day
 * window, so today's partial day, leading empty days and gaps all occur.
 */
const trendRowsArb: fc.Arbitrary<TrendCase> = fc
  .record({
    clockDay: fc.integer({ min: -50, max: 50 }),
    msIntoDay: fc.integer({ min: 0, max: DAY_MS - 1 }),
    buckets: fc.array(
      fc.record({
        daysBack: fc.integer({ min: 0, max: 70 }),
        modelId: fc.constantFrom(...MODEL_IDS),
        count: fc.integer({ min: 1, max: 40 }),
      }),
      { maxLength: 12 }
    ),
  })
  .map(({ clockDay, msIntoDay, buckets }) => {
    const todayMs = TEST_DAY_START + clockDay * DAY_MS;
    return {
      now: new Date(todayMs + msIntoDay),
      entries: buckets.map(({ daysBack, modelId, count }) => ({
        createdAtMs: todayMs - daysBack * DAY_MS,
        modelId,
        count,
      })),
    };
  });

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function bucketStartOf(ms: number, bucket: UsageStatsTrendBucket): string {
  const d = new Date(ms);
  return bucket === 'day'
    ? isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function inQuery(entry: UsageEntry, query: GlobalUsageWindowQuery): boolean {
  if (query.modality !== 'text') return false;
  if (entry.createdAtMs >= query.end.getTime()) return false;
  return query.start === null || entry.createdAtMs >= query.start.getTime();
}

/** In-memory reads over the entries, with the SQL adapter's bounds; snapshots are never written. */
function storesOver(
  entries: readonly UsageEntry[],
  trendRowsFilter: (
    query: GlobalUsageWindowQuery,
    rows: readonly GlobalTrendCountRow[]
  ) => readonly GlobalTrendCountRow[] = (_query, rows) => rows
): PublicStatsStores {
  return {
    aggregateGlobalUsageByModel(_db, query) {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        if (!inQuery(entry, query)) continue;
        counts.set(entry.modelId, (counts.get(entry.modelId) ?? 0) + entry.count);
      }
      return okAsync(
        [...counts].map(([modelId, messageCount]) => ({
          modelId,
          messageCount,
          costNanoUsd: BigInt(messageCount) * 1_000_000n,
        }))
      );
    },
    readGlobalCostPercentiles(_db, query) {
      const any = entries.some((entry) => inQuery(entry, query));
      return okAsync(any ? { medianNanoUsd: 1_000_000, p90NanoUsd: 1_000_000 } : null);
    },
    readGlobalTrendCounts(_db, query) {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        if (!inQuery(entry, query)) continue;
        const key = `${bucketStartOf(entry.createdAtMs, query.bucket)}|${entry.modelId}`;
        counts.set(key, (counts.get(key) ?? 0) + entry.count);
      }
      const rows = [...counts].map(([key, messageCount]) => {
        const [bucketStart = '', modelId = ''] = key.split('|');
        return { bucketStart, modelId, messageCount };
      });
      return okAsync(trendRowsFilter(query, rows));
    },
    insertPublicStatsSnapshot() {
      throw new Error('the trend property never writes a snapshot');
    },
    readLatestPublicStatsSnapshot() {
      throw new Error('the trend property never reads a snapshot');
    },
  };
}

async function buildOver(now: Date, stores: PublicStatsStores): Promise<PublicUsageStats> {
  const result = await buildPublicUsageStats({
    db,
    stores,
    now,
    resolveModelMeta: () => okAsync(new Map()),
  });
  return result._unsafeUnwrap();
}

function windowStartMs(window: UsageStatsWindow, now: Date): number | null {
  return window.days === null ? null : now.getTime() - window.days * DAY_MS;
}

/** The bucket starts holding usage the series counts: inside the window, before today. */
function dataBuckets(
  entries: readonly UsageEntry[],
  window: UsageStatsWindow,
  now: Date
): ReadonlySet<string> {
  const startMs = windowStartMs(window, now);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const buckets = new Set<string>();
  for (const entry of entries) {
    if (entry.createdAtMs >= todayMs) continue;
    if (startMs !== null && entry.createdAtMs < startMs) continue;
    buckets.add(bucketStartOf(entry.createdAtMs, window.trendBucket));
  }
  return buckets;
}

type TrendPoint = UsageStatsWindowStats['trend']['points'][number];

function sharesOf(point: TrendPoint | undefined): Omit<TrendPoint, 'start'> | undefined {
  if (point === undefined) return undefined;
  return { models: point.models, othersSharePercent: point.othersSharePercent };
}

/** The point a bucket gets when the trend read returns that bucket's rows and no other. */
async function isolatedPoint(
  entries: readonly UsageEntry[],
  now: Date,
  window: UsageStatsWindow,
  start: string
): Promise<TrendPoint | undefined> {
  const startMs = windowStartMs(window, now);
  const stats = await buildOver(
    now,
    storesOver(entries, (query, rows) =>
      (query.start?.getTime() ?? null) === startMs
        ? rows.filter((row) => row.bucketStart === start)
        : rows
    )
  );
  return stats.modalities.text?.[window.key]?.trend.points[0];
}

/** Every window series the build produced for the case, with the buckets holding its data. */
async function seriesOf(trendCase: TrendCase): Promise<
  readonly {
    window: UsageStatsWindow;
    points: readonly TrendPoint[];
    withData: ReadonlySet<string>;
  }[]
> {
  const { now, entries } = trendCase;
  const stats = await buildOver(now, storesOver(entries));
  return USAGE_STATS_WINDOWS.flatMap((window) => {
    const windowStats = stats.modalities.text?.[window.key];
    if (windowStats === undefined) return [];
    return [
      { window, points: windowStats.trend.points, withData: dataBuckets(entries, window, now) },
    ];
  });
}

describe('the public usage trend series', () => {
  it('starts at the first bucket with data', async () => {
    await fc.assert(
      fc.asyncProperty(trendRowsArb, async (trendCase) => {
        for (const { points, withData } of await seriesOf(trendCase)) {
          const firstData = [...withData].toSorted((a, b) => a.localeCompare(b))[0];
          expect(points[0]?.start).toBe(firstData);
        }
      })
    );
  });

  it('ends no later than the bucket holding yesterday', async () => {
    await fc.assert(
      fc.asyncProperty(trendRowsArb, async (trendCase) => {
        const yesterday = isoDate(trendCase.now.getTime() - DAY_MS);
        for (const { points } of await seriesOf(trendCase)) {
          for (const point of points) {
            expect(point.start.localeCompare(yesterday)).toBeLessThanOrEqual(0);
          }
        }
      })
    );
  });

  it('repeats the previous point over a bucket without data', async () => {
    await fc.assert(
      fc.asyncProperty(trendRowsArb, async (trendCase) => {
        for (const { points, withData } of await seriesOf(trendCase)) {
          for (const [index, point] of points.entries()) {
            if (withData.has(point.start)) continue;
            expect(index).toBeGreaterThan(0);
            expect(sharesOf(point)).toEqual(sharesOf(points[index - 1]));
          }
        }
      })
    );
  });

  it('computes a bucket with data from its own rows alone', async () => {
    await fc.assert(
      fc.asyncProperty(trendRowsArb, async (trendCase) => {
        for (const { window, points, withData } of await seriesOf(trendCase)) {
          for (const point of points) {
            if (!withData.has(point.start)) continue;
            const alone = await isolatedPoint(
              trendCase.entries,
              trendCase.now,
              window,
              point.start
            );
            expect(alone).toEqual(point);
          }
        }
      })
    );
  });
});
