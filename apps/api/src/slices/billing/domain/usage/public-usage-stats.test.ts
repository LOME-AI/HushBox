import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  TEST_DAY_START,
  TEST_MONTH_START,
  TEST_YEAR_START,
} from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import {
  buildPublicUsageStats,
  gateShareList,
  readLatestPublicStatsSnapshot,
  savePublicStatsSnapshot,
} from './public-usage-stats.js';
import type { Database } from '@hushbox/db';
import type { Modality, PublicUsageStats, UsageStatsWindowStats } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  GlobalUsageWindowQuery,
  PublicStatsSnapshotRow,
  PublicStatsStores,
} from '../../ports/public-stats.js';

const db = {} as unknown as Database;
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

interface FakeRecord {
  readonly modelId: string;
  readonly modality: Modality;
  readonly costNanoUsd: bigint;
  readonly createdAt: Date;
}

function rep(
  n: number,
  modelId: string,
  createdAt: Date,
  options: { readonly costNanoUsd?: bigint; readonly modality?: Modality } = {}
): FakeRecord[] {
  const { costNanoUsd = 1_000_000n, modality = 'text' } = options;
  return Array.from({ length: n }, () => ({ modelId, modality, costNanoUsd, createdAt }));
}

function inWindow(record: FakeRecord, query: GlobalUsageWindowQuery): boolean {
  if (record.modality !== query.modality) return false;
  if (record.createdAt.getTime() >= query.end.getTime()) return false;
  return query.start === null || record.createdAt.getTime() >= query.start.getTime();
}

function percentileCont(sorted: readonly number[], p: number): number {
  const index = p * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (index - lo) * (hiVal - loVal);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** In-memory PublicStatsStores mirroring the SQL adapter's semantics. */
function fakeStores(records: readonly FakeRecord[]): PublicStatsStores {
  const snapshots: PublicStatsSnapshotRow[] = [];
  return {
    aggregateGlobalUsageByModel(_db, query) {
      const byModel = new Map<string, { messageCount: number; costNanoUsd: bigint }>();
      for (const r of records) {
        if (!inWindow(r, query)) continue;
        const agg = byModel.get(r.modelId) ?? { messageCount: 0, costNanoUsd: 0n };
        byModel.set(r.modelId, {
          messageCount: agg.messageCount + 1,
          costNanoUsd: agg.costNanoUsd + r.costNanoUsd,
        });
      }
      return okAsync(
        [...byModel.entries()]
          .map(([modelId, agg]) => ({ modelId, ...agg }))
          .toSorted((a, b) => a.modelId.localeCompare(b.modelId))
      );
    },
    readGlobalCostPercentiles(_db, query) {
      const costs = records
        .filter((r) => inWindow(r, query))
        .map((r) => Number(r.costNanoUsd))
        .toSorted((a, b) => a - b);
      if (costs.length === 0) return okAsync(null);
      return okAsync({
        medianNanoUsd: percentileCont(costs, 0.5),
        p90NanoUsd: percentileCont(costs, 0.9),
      });
    },
    readGlobalTrendCounts(_db, query) {
      const byKey = new Map<string, number>();
      for (const r of records) {
        if (!inWindow(r, query)) continue;
        const d = r.createdAt;
        const bucketStart =
          query.bucket === 'day'
            ? isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
            : isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
        const key = `${bucketStart}|${r.modelId}`;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
      }
      return okAsync(
        [...byKey.entries()].map(([key, messageCount]) => {
          const [bucketStart = '', modelId = ''] = key.split('|');
          return { bucketStart, modelId, messageCount };
        })
      );
    },
    insertPublicStatsSnapshot(_db, input) {
      const row: PublicStatsSnapshotRow = {
        id: `snap-${String(snapshots.length + 1)}`,
        schemaVersion: input.schemaVersion,
        stats: input.stats,
        createdAt: new Date(NOW.getTime() + snapshots.length),
      };
      snapshots.push(row);
      return okAsync(row);
    },
    readLatestPublicStatsSnapshot(_db, schemaVersion) {
      const matching = snapshots.filter((s) => s.schemaVersion === schemaVersion);
      return okAsync(matching.at(-1) ?? null);
    },
  };
}

type ModelMetaMap = ReadonlyMap<string, { displayName: string; provider: string }>;

function metaResolver(
  meta: Record<string, { displayName: string; provider: string }> = {}
): (ids: readonly string[]) => ResultAsync<ModelMetaMap, DomainError> {
  return () => okAsync(new Map(Object.entries(meta)));
}

function build(
  records: readonly FakeRecord[],
  meta: Record<string, { displayName: string; provider: string }> = {}
): ReturnType<typeof buildPublicUsageStats> {
  return buildPublicUsageStats({
    db,
    stores: fakeStores(records),
    now: NOW,
    resolveModelMeta: metaResolver(meta),
  });
}

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

async function unwrapErr<T>(result: ResultAsync<T, DomainError>): Promise<DomainError> {
  const settled = await result;
  return settled._unsafeUnwrapErr();
}

function textWindow(stats: PublicUsageStats, key: '7d' | '30d' | 'all'): UsageStatsWindowStats {
  const win = stats.modalities.text?.[key];
  if (win === undefined) throw new Error(`expected text ${key} window`);
  return win;
}

describe('buildPublicUsageStats', () => {
  it('returns an empty modalities record when no usage exists', async () => {
    const stats = await unwrap(build([]));
    expect(stats.modalities).toEqual({});
  });

  it('stamps schemaVersion and generatedAt from the injected clock', async () => {
    const stats = await unwrap(build([]));
    expect(stats.schemaVersion).toBe(PUBLIC_USAGE_STATS_SCHEMA_VERSION);
    expect(stats.generatedAt).toBe(NOW.toISOString());
  });

  it('omits a window with no records and a modality with no data anywhere', async () => {
    // Image usage exists only 40 days back: outside 7d and 30d, inside all.
    const records = rep(10, 'img/model', new Date(NOW.getTime() - 40 * DAY_MS), {
      modality: 'image',
    });
    const stats = await unwrap(build(records));
    expect(Object.keys(stats.modalities)).toEqual(['image']);
    expect(Object.keys(stats.modalities.image ?? {})).toEqual(['all']);
  });

  it('folds sub-2% models into Others with their true combined share', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = [
      ...rep(500, 'm/a', at),
      ...rep(300, 'm/b', at),
      ...rep(190, 'm/c', at),
      ...rep(10, 'm/tiny', at),
    ];
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models.map((m) => [m.modelId, m.sharePercent])).toEqual([
      ['m/a', 50],
      ['m/b', 30],
      ['m/c', 19],
    ]);
    expect(win.others.sharePercent).toBe(1);
  });

  it('rounds shares to whole percents below the low-volume threshold', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = [...rep(2, 'm/a', at), ...rep(1, 'm/b', at)];
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models.map((m) => [m.modelId, m.sharePercent])).toEqual([
      ['m/a', 67],
      ['m/b', 33],
    ]);
    expect(win.others.sharePercent).toBe(0);
  });

  it('computes deltas vs the prior equal window over the current displayed set', async () => {
    const current = new Date(NOW.getTime() - 3 * DAY_MS);
    const prior = new Date(NOW.getTime() - 10 * DAY_MS);
    const records = [
      ...rep(600, 'm/a', current),
      ...rep(400, 'm/b', current),
      ...rep(500, 'm/a', prior),
      ...rep(250, 'm/b', prior),
      ...rep(250, 'm/c', prior),
    ];
    const stats = await unwrap(build(records));
    const win7 = textWindow(stats, '7d');
    expect(win7.models.map((m) => [m.modelId, m.sharePercent, m.deltaPoints])).toEqual([
      ['m/a', 60, 10],
      ['m/b', 40, 15],
    ]);
    // Others' prior apportioned share over the same displayed set was 25%.
    expect(win7.others).toEqual({ sharePercent: 0, deltaPoints: -25 });
    // The all-time window never carries deltas.
    const winAll = textWindow(stats, 'all');
    expect(winAll.models.every((m) => m.deltaPoints === null)).toBe(true);
    expect(winAll.others.deltaPoints).toBeNull();
  });

  it('returns null deltas when the prior window is empty', async () => {
    const records = rep(100, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS));
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models[0]?.deltaPoints).toBeNull();
    expect(win.others.deltaPoints).toBeNull();
  });

  it('uses resolved model meta and falls back to the raw id when missing', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = [...rep(2, 'm/known', at), ...rep(2, 'm/unknown', at)];
    const win = textWindow(
      await unwrap(build(records, { 'm/known': { displayName: 'Known One', provider: 'acme' } })),
      '7d'
    );
    const known = win.models.find((m) => m.modelId === 'm/known');
    const unknown = win.models.find((m) => m.modelId === 'm/unknown');
    expect(known).toMatchObject({ displayName: 'Known One', provider: 'acme' });
    expect(unknown).toMatchObject({ displayName: 'm/unknown', provider: 'm/unknown' });
  });

  it('serializes costs as decimal USD strings with 4 significant digits', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    // avg 123,456,789 nano-USD = 0.123456789 USD → 4 significant digits.
    const records = rep(1, 'm/a', at, { costNanoUsd: 123_456_789n });
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models[0]?.avgCostUsd).toBe('0.1235');
    expect(win.cost).toEqual({ avgUsd: '0.1235', medianUsd: '0.1235', p90Usd: '0.1235' });
  });

  it('serializes a zero cost as "0"', async () => {
    const records = rep(3, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS), { costNanoUsd: 0n });
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models[0]?.avgCostUsd).toBe('0');
    expect(win.cost).toEqual({ avgUsd: '0', medianUsd: '0', p90Usd: '0' });
  });

  it('carries a data day forward through the empty days after it, up to yesterday', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = [...rep(3, 'm/a', at), ...rep(1, 'm/b', at)];
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.trend.bucket).toBe('day');
    expect(win.trend.points.map((p) => p.start)).toEqual(
      [5, 4, 3, 2, 1].map((daysBack) => isoDate(NOW.getTime() - daysBack * DAY_MS))
    );
    for (const point of win.trend.points) {
      expect(point.models).toEqual([
        { modelId: 'm/a', sharePercent: 75 },
        { modelId: 'm/b', sharePercent: 25 },
      ]);
      expect(point.othersSharePercent).toBe(0);
    }
  });

  it('starts a 7-day series at its first data day and repeats the previous point over empty days', async () => {
    // The window's days run from 7 days back (day 1) to yesterday (day 7).
    const windowDay = (day: number): Date => new Date(NOW.getTime() - (8 - day) * DAY_MS);
    const records = [
      ...rep(1, 'm/a', windowDay(2)),
      ...rep(1, 'm/a', windowDay(3)),
      ...rep(3, 'm/b', windowDay(3)),
      ...rep(4, 'm/c', windowDay(6)),
    ];
    const points = textWindow(await unwrap(build(records)), '7d').trend.points;
    const startOf = (day: number): string => isoDate(windowDay(day).getTime());
    expect(points.map((p) => p.start)).toEqual([2, 3, 4, 5, 6, 7].map((day) => startOf(day)));
    const [day2, day3, day4, day5, day6, day7] = points;
    expect(day2?.models.find((m) => m.modelId === 'm/a')?.sharePercent).toBe(100);
    expect(day3?.models.find((m) => m.modelId === 'm/b')?.sharePercent).toBe(75);
    expect({ ...day4, start: day3?.start }).toEqual(day3);
    expect({ ...day5, start: day3?.start }).toEqual(day3);
    expect(day6?.models.find((m) => m.modelId === 'm/c')?.sharePercent).toBe(100);
    expect({ ...day7, start: day6?.start }).toEqual(day6);
  });

  it('has no point for today in any window', async () => {
    const records = [
      ...rep(2, 'm/a', new Date(NOW.getTime() - DAY_MS)),
      ...rep(2, 'm/b', new Date(TEST_DAY_START)),
    ];
    const stats = await unwrap(build(records));
    const today = isoDate(NOW.getTime());
    for (const key of ['7d', '30d'] as const) {
      const starts = textWindow(stats, key).trend.points.map((p) => p.start);
      expect(starts.at(-1)).toBe(isoDate(NOW.getTime() - DAY_MS));
      expect(starts).not.toContain(today);
    }
  });

  it('counts the current month only through yesterday', async () => {
    const records = [
      ...rep(2, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS)),
      ...rep(2, 'm/b', new Date(TEST_DAY_START)),
    ];
    const points = textWindow(await unwrap(build(records)), 'all').trend.points;
    expect(points).toEqual([
      {
        start: isoDate(TEST_YEAR_START),
        models: [
          { modelId: 'm/a', sharePercent: 100 },
          { modelId: 'm/b', sharePercent: 0 },
        ],
        othersSharePercent: 0,
      },
    ]);
  });

  it('omits the current month from a month-bucket series on the first of the month', async () => {
    const firstOfMonth = new Date(TEST_MONTH_START + 12 * HOUR_MS);
    const records = [
      ...rep(2, 'm/a', new Date(TEST_MONTH_START - 3 * DAY_MS)),
      ...rep(2, 'm/a', new Date(TEST_MONTH_START)),
    ];
    const stats = await unwrap(
      buildPublicUsageStats({
        db,
        stores: fakeStores(records),
        now: firstOfMonth,
        resolveModelMeta: metaResolver(),
      })
    );
    const starts = textWindow(stats, 'all').trend.points.map((p) => p.start);
    expect(starts).toEqual([isoDate(TEST_YEAR_START)]);
  });

  it('sums every trend point to exactly 100', async () => {
    const records = [
      ...rep(5, 'm/a', new Date(NOW.getTime() - 6 * DAY_MS)),
      ...rep(1, 'm/b', new Date(NOW.getTime() - 6 * DAY_MS)),
      ...rep(1, 'm/a', new Date(NOW.getTime() - 3 * DAY_MS)),
      ...rep(1, 'm/b', new Date(NOW.getTime() - 3 * DAY_MS)),
      ...rep(1, 'm/c', new Date(NOW.getTime() - 3 * DAY_MS)),
    ];
    const stats = await unwrap(build(records));
    for (const key of ['7d', '30d', 'all'] as const) {
      const { points } = textWindow(stats, key).trend;
      expect(points.length).toBeGreaterThan(0);
      for (const point of points) {
        const gate = gateShareList(
          point.models.map((m) => Math.round(m.sharePercent * 10)),
          Math.round(point.othersSharePercent * 10)
        );
        expect(gate.isOk()).toBe(true);
      }
    }
  });

  it('renders an empty series when every record is from today', async () => {
    const stats = await unwrap(build(rep(3, 'm/a', new Date(TEST_DAY_START))));
    for (const key of ['7d', '30d', 'all'] as const) {
      expect(textWindow(stats, key).trend.points).toEqual([]);
    }
  });

  it('buckets the all-time trend by month from the earliest record', async () => {
    const records = [
      ...rep(2, 'm/a', new Date(TEST_DAY_START - 61 * DAY_MS)),
      ...rep(2, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS)),
    ];
    const win = textWindow(await unwrap(build(records)), 'all');
    expect(win.trend.bucket).toBe('month');
    expect(win.trend.points.map((p) => p.start)).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
    ]);
  });

  it('contains no count-like keys anywhere in the payload', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = [...rep(1200, 'm/a', at), ...rep(300, 'm/b', at)];
    const stats = await unwrap(build(records));
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(stats);
    expect(keys.some((k) => /count|message|token|record|user/i.test(k))).toBe(false);
  });

  it('apportions six equal models to exactly 100 by largest remainder', async () => {
    // Naive rounding gives 17% × 6 = 102; largest-remainder apportionment
    // floors to 16 each and hands the 4 leftover points to the first four
    // model ids (all remainders tie), so the list sums to exactly 100.
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((m) => rep(1, `m/${m}`, at));
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models.map((m) => [m.modelId, m.sharePercent])).toEqual([
      ['m/a', 17],
      ['m/b', 17],
      ['m/c', 17],
      ['m/d', 17],
      ['m/e', 16],
      ['m/f', 16],
    ]);
    expect(win.others.sharePercent).toBe(0);
  });

  it('apportions equal thirds to 33.4/33.3/33.3 at tenth precision', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const records = [...rep(400, 'm/a', at), ...rep(400, 'm/b', at), ...rep(400, 'm/c', at)];
    const win = textWindow(await unwrap(build(records)), '7d');
    expect(win.models.map((m) => [m.modelId, m.sharePercent])).toEqual([
      ['m/a', 33.4],
      ['m/b', 33.3],
      ['m/c', 33.3],
    ]);
    expect(win.others.sharePercent).toBe(0);
  });

  it('fails with a validation error when a trend bucket falls outside the window', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const stores = fakeStores(rep(4, 'm/a', at));
    const rogue: PublicStatsStores = {
      ...stores,
      readGlobalTrendCounts: () =>
        okAsync([{ bucketStart: '1999-01-01', modelId: 'm/a', messageCount: 4 }]),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: rogue, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('validation');
  });

  it('fails with a validation error when percentiles are missing for a non-empty window', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const stores = fakeStores(rep(4, 'm/a', at));
    const rogue: PublicStatsStores = { ...stores, readGlobalCostPercentiles: () => okAsync(null) };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: rogue, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('validation');
  });

  it('propagates a store failure', async () => {
    const stores = fakeStores([]);
    const failing: PublicStatsStores = {
      ...stores,
      aggregateGlobalUsageByModel: () => errAsync(unavailableError('boom')),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({
        db,
        stores: failing,
        now: NOW,
        resolveModelMeta: metaResolver(),
      })
    );
    expect(error.code).toBe('unavailable');
  });

  it('propagates a model-meta resolution failure', async () => {
    const records = rep(4, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS));
    const error = await unwrapErr(
      buildPublicUsageStats({
        db,
        stores: fakeStores(records),
        now: NOW,
        resolveModelMeta: () => errAsync(unavailableError('meta down')),
      })
    );
    expect(error.code).toBe('unavailable');
  });

  it('fails with a validation error when a trend point share falls outside [0, 100]', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const day = at.toISOString().slice(0, 10);
    const stores = fakeStores(rep(4, 'm/a', at));
    const rogue: PublicStatsStores = {
      ...stores,
      readGlobalTrendCounts: () =>
        okAsync([
          { bucketStart: day, modelId: 'm/a', messageCount: -3 },
          { bucketStart: day, modelId: 'm/x', messageCount: 6 },
        ]),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: rogue, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('validation');
  });

  it('propagates a percentile store failure', async () => {
    const stores = fakeStores(rep(4, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS)));
    const failing: PublicStatsStores = {
      ...stores,
      readGlobalCostPercentiles: () => errAsync(unavailableError('percentiles down')),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: failing, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('unavailable');
  });

  it('propagates a trend store failure', async () => {
    const stores = fakeStores(rep(4, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS)));
    const failing: PublicStatsStores = {
      ...stores,
      readGlobalTrendCounts: () => errAsync(unavailableError('trend down')),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: failing, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('unavailable');
  });

  it('propagates a prior-window aggregate failure', async () => {
    const stores = fakeStores(rep(4, 'm/a', new Date(NOW.getTime() - 5 * DAY_MS)));
    // The current-window aggregate succeeds; only the prior (earlier-ending)
    // window's aggregate fails.
    const failing: PublicStatsStores = {
      ...stores,
      aggregateGlobalUsageByModel: (innerDb, query) =>
        query.end.getTime() < NOW.getTime()
          ? errAsync(unavailableError('prior window down'))
          : stores.aggregateGlobalUsageByModel(innerDb, query),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: failing, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('unavailable');
  });

  it('fails with a validation error when a share falls outside [0, 100]', async () => {
    const stores = fakeStores([]);
    const rogue: PublicStatsStores = {
      ...stores,
      aggregateGlobalUsageByModel: () =>
        okAsync([
          { modelId: 'm/neg', messageCount: -5, costNanoUsd: 0n },
          { modelId: 'm/pos', messageCount: 10, costNanoUsd: 0n },
        ]),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: rogue, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('validation');
  });

  it('treats a displayed model absent from the prior window as a 0% baseline', async () => {
    const current = new Date(NOW.getTime() - 3 * DAY_MS);
    const prior = new Date(NOW.getTime() - 10 * DAY_MS);
    const records = [
      ...rep(600, 'm/a', current),
      ...rep(400, 'm/new', current),
      ...rep(800, 'm/a', prior),
    ];
    const win = textWindow(await unwrap(build(records)), '7d');
    // Prior window: m/a held 100%; m/new had no baseline (0%).
    expect(win.models.map((m) => [m.modelId, m.deltaPoints])).toEqual([
      ['m/a', -40],
      ['m/new', 40],
    ]);
  });

  it('fails the final schema gate when a model id is empty', async () => {
    // An empty model id survives the numeric gates but violates the wire
    // schema's min-length — the safeParse write-gate must catch it.
    const records = rep(4, '', new Date(NOW.getTime() - 5 * DAY_MS));
    const error = await unwrapErr(build(records));
    expect(error.code).toBe('validation');
  });

  it('renders an empty series when the trend read returns no rows', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const stores = fakeStores(rep(4, 'm/a', at));
    const rogue: PublicStatsStores = { ...stores, readGlobalTrendCounts: () => okAsync([]) };
    const stats = await unwrap(
      buildPublicUsageStats({ db, stores: rogue, now: NOW, resolveModelMeta: metaResolver() })
    );
    for (const key of ['7d', '30d', 'all'] as const) {
      expect(textWindow(stats, key).trend.points).toEqual([]);
    }
  });

  it('fails with a validation error when a trend bucket counts sum to zero', async () => {
    const at = new Date(NOW.getTime() - 5 * DAY_MS);
    const day = at.toISOString().slice(0, 10);
    const stores = fakeStores(rep(4, 'm/a', at));
    const rogue: PublicStatsStores = {
      ...stores,
      readGlobalTrendCounts: (innerDb, query) =>
        query.bucket === 'day'
          ? okAsync([
              { bucketStart: day, modelId: 'm/a', messageCount: -3 },
              { bucketStart: day, modelId: 'm/x', messageCount: 3 },
            ])
          : stores.readGlobalTrendCounts(innerDb, query),
    };
    const error = await unwrapErr(
      buildPublicUsageStats({ db, stores: rogue, now: NOW, resolveModelMeta: metaResolver() })
    );
    expect(error.code).toBe('validation');
  });
});

describe('gateShareList', () => {
  it('accepts an in-range list summing to exactly 100', () => {
    expect(gateShareList([600, 400], 0).isOk()).toBe(true);
  });

  it('rejects a share outside [0, 100]', () => {
    const error = gateShareList([1200], 0)._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.message).toContain('share outside');
  });

  it('rejects an in-range list that does not sum to 100', () => {
    const error = gateShareList([500, 400], 0)._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.message).toContain('does not sum to 100');
  });
});

describe('savePublicStatsSnapshot', () => {
  it('parses the payload as the final gate and inserts it', async () => {
    const stores = fakeStores([]);
    const stats = await unwrap(build([]));
    const row = await unwrap(savePublicStatsSnapshot(stores, db, stats));
    expect(row.schemaVersion).toBe(PUBLIC_USAGE_STATS_SCHEMA_VERSION);
    expect(row.stats).toEqual(stats);
  });

  it('rejects a payload that fails the schema gate without inserting', async () => {
    const stores = fakeStores([]);
    const insertSpy = vi.spyOn(stores, 'insertPublicStatsSnapshot');
    const smuggled = {
      schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
      generatedAt: NOW.toISOString(),
      modalities: {},
      totalMessages: 12_345,
    } as unknown as PublicUsageStats;
    const error = await unwrapErr(savePublicStatsSnapshot(stores, db, smuggled));
    expect(error.code).toBe('validation');
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('readLatestPublicStatsSnapshot', () => {
  it('returns the latest snapshot matching the schema version', async () => {
    const stores = fakeStores([]);
    const stats = await unwrap(build([]));
    await unwrap(savePublicStatsSnapshot(stores, db, stats));
    const second = await unwrap(savePublicStatsSnapshot(stores, db, stats));
    const latest = await unwrap(
      readLatestPublicStatsSnapshot(stores, db, PUBLIC_USAGE_STATS_SCHEMA_VERSION)
    );
    expect(latest?.id).toBe(second.id);
  });

  it('returns null when no snapshot exists for the version', async () => {
    const latest = await unwrap(
      readLatestPublicStatsSnapshot(fakeStores([]), db, PUBLIC_USAGE_STATS_SCHEMA_VERSION)
    );
    expect(latest).toBeNull();
  });
});
