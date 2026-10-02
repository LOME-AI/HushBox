import { describe, it, expect } from 'vitest';
import { USAGE_STATS_WINDOWS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  availableModalities,
  availableWindows,
  defaultWindowKey,
  rankModels,
  colorForRank,
  OTHERS_COLOR,
  formatUsd,
  formatDelta,
  formatShare,
  trendSeries,
  xAxisTicks,
  tickSpan,
  tickLabelWidthRem,
  tickThresholds,
  MONO_TICK_CHARACTER_EM,
  WIDGET_FACE_TICK_CHARACTER_EM,
  type TickTier,
  type XAxisTick,
  Y_AXIS_TICKS,
  dotPlotPositions,
  selectView,
} from './compute-stats';
import type { PublicUsageStats, UsageStatsWindowStats } from '@hushbox/shared';

function windowStats(overrides: Partial<UsageStatsWindowStats> = {}): UsageStatsWindowStats {
  return {
    models: [
      {
        modelId: 'a/one',
        displayName: 'One',
        provider: 'a',
        sharePercent: 40,
        deltaPoints: 2.1,
        avgCostUsd: '0.01',
      },
      {
        modelId: 'b/two',
        displayName: 'Two',
        provider: 'b',
        sharePercent: 50,
        deltaPoints: -0.4,
        avgCostUsd: '0.002',
      },
    ],
    others: { sharePercent: 10, deltaPoints: null },
    trend: {
      bucket: 'day',
      points: [
        {
          start: '2026-06-01',
          models: [
            { modelId: 'a/one', sharePercent: 40 },
            { modelId: 'b/two', sharePercent: 50 },
          ],
          othersSharePercent: 10,
        },
        {
          start: '2026-06-02',
          models: [{ modelId: 'b/two', sharePercent: 80 }],
          othersSharePercent: 20,
        },
      ],
    },
    cost: { avgUsd: '0.0051', medianUsd: '0.003', p90Usd: '0.02' },
    ...overrides,
  };
}

function stats(modalities: PublicUsageStats['modalities']): PublicUsageStats {
  return { schemaVersion: 1, generatedAt: isoAt(TEST_DAY_START), modalities };
}

describe('availableModalities', () => {
  it('returns only modalities present in the payload, in canonical order', () => {
    const data = stats({
      video: { '30d': windowStats() },
      text: { '30d': windowStats() },
    });
    expect(availableModalities(data)).toEqual(['text', 'video']);
  });

  it('excludes a modality whose window record is empty', () => {
    const data = stats({ text: { '30d': windowStats() }, image: {} });
    expect(availableModalities(data)).toEqual(['text']);
  });
});

describe('availableWindows', () => {
  it('returns the declared windows that have data for the modality, in declaration order', () => {
    const data = stats({ text: { all: windowStats(), '7d': windowStats() } });
    expect(availableWindows(data, 'text').map((w) => w.key)).toEqual(['7d', 'all']);
  });

  it('returns an empty list for an absent modality', () => {
    const data = stats({ text: { '30d': windowStats() } });
    expect(availableWindows(data, 'image')).toEqual([]);
  });
});

describe('defaultWindowKey', () => {
  it('prefers 30d when present', () => {
    expect(defaultWindowKey(USAGE_STATS_WINDOWS)).toBe('30d');
  });

  it('falls back to the first available window when 30d is absent', () => {
    const windows = USAGE_STATS_WINDOWS.filter((w) => w.key !== '30d');
    expect(defaultWindowKey(windows)).toBe('7d');
  });

  it('throws on an empty window list', () => {
    expect(() => defaultWindowKey([])).toThrow(/at least one window/);
  });
});

describe('rankModels', () => {
  it('orders models by descending share and assigns 1-based ranks', () => {
    const ranked = rankModels(windowStats());
    expect(ranked.map((m) => m.modelId)).toEqual(['b/two', 'a/one']);
    expect(ranked.map((m) => m.rank)).toEqual([1, 2]);
  });

  it('assigns chart token colors by rank', () => {
    const ranked = rankModels(windowStats());
    expect(ranked[0]?.color).toBe('var(--chart-1)');
    expect(ranked[1]?.color).toBe('var(--chart-2)');
  });
});

describe('colorForRank', () => {
  it('assigns the five chart tokens to ranks 1-5', () => {
    expect([1, 2, 3, 4, 5].map((rank) => colorForRank(rank))).toEqual([
      'var(--chart-1)',
      'var(--chart-2)',
      'var(--chart-3)',
      'var(--chart-4)',
      'var(--chart-5)',
    ]);
  });

  it('assigns the teal, magenta and slate model tokens to ranks 6-8', () => {
    expect([6, 7, 8].map((rank) => colorForRank(rank))).toEqual([
      'var(--model-1)',
      'var(--model-7)',
      'var(--model-6)',
    ]);
  });

  it('repeats the eight colours from rank 9', () => {
    expect(colorForRank(9)).toBe('var(--chart-1)');
    expect(colorForRank(16)).toBe('var(--model-6)');
  });

  it('refuses a rank below 1', () => {
    expect(() => colorForRank(0)).toThrow(/positive integer rank/);
  });
});

describe('OTHERS_COLOR', () => {
  it('is muted ink mixed into the page background', () => {
    expect(OTHERS_COLOR).toBe('color-mix(in srgb, var(--foreground-muted) 55%, var(--background))');
  });
});

describe('formatUsd', () => {
  it('prefixes a dollar sign', () => {
    expect(formatUsd('0.0051')).toBe('$0.0051');
  });

  it('trims trailing fraction zeros', () => {
    expect(formatUsd('0.0100')).toBe('$0.01');
  });

  it('drops a fraction that trims to nothing', () => {
    expect(formatUsd('2.000')).toBe('$2');
  });

  it('leaves integer strings untouched', () => {
    expect(formatUsd('3')).toBe('$3');
  });
});

describe('formatDelta', () => {
  it('renders positive deltas with an explicit plus sign', () => {
    expect(formatDelta(2.1)).toBe('+2.1');
  });

  it('renders negative deltas with a minus sign', () => {
    expect(formatDelta(-0.4)).toBe('-0.4');
  });

  it('renders zero as +0.0', () => {
    expect(formatDelta(0)).toBe('+0.0');
  });
});

describe('formatShare', () => {
  it('renders one decimal place with a percent sign', () => {
    expect(formatShare(40)).toBe('40.0%');
  });
});

describe('trendSeries', () => {
  /** The y coordinate of each vertex of a path, in path order. */
  function pathYs(path: string): number[] {
    return [...path.matchAll(/[ML] -?[\d.]+ (-?[\d.]+)/g)].map((match) => Number(match[1]));
  }

  it('returns one band per ranked model plus Others last', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.map((s) => s.label)).toEqual(['Two', 'One', 'Others']);
    expect(series.at(-1)?.color).toBe(OTHERS_COLOR);
  });

  it('treats a model missing from a point as zero share there', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // 'a/one' holds 40 at the first point and is absent from the second. One
    // stacks directly on Two, so the gap between their top edges at each point
    // is the share One contributes there.
    const one = pathYs(series.find((s) => s.label === 'One')!.topPath);
    const two = pathYs(series.find((s) => s.label === 'Two')!.topPath);
    expect(two.map((y, index) => y - one[index]!)).toEqual([40, 0]);
  });

  it('closes the Others polygon along the chart top', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // A band polygon runs its lower edge forward then its upper edge reversed,
    // so the trailing half of its vertices is the Others band's own top.
    const ys = pathYs(series.find((s) => s.label === 'Others')!.path);
    expect(ys.slice(ys.length / 2)).toEqual([0, 0]);
  });

  it('exposes a top-boundary line path per band tracing its upper edge', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // Stack bottom-up: Two upper = [50, 80] → y [50, 20]; One upper = [90, 80] → y [10, 20].
    expect(series.map((s) => s.topPath)).toEqual([
      'M 0 50 L 100 20',
      'M 0 10 L 100 20',
      'M 0 0 L 100 0',
    ]);
  });

  it('draws each band as a polygon tracing its lower edge forward then its upper edge reversed', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // Two points, so x = [0, 100]. Stacked shares bottom-up are Two [50, 80], One [40, 0],
    // Others [10, 20]; chart y is 100 − the cumulative share at that vertex.
    expect(series.map((s) => s.path)).toEqual([
      'M 0 100 L 100 100 L 100 20 L 0 50 Z',
      'M 0 50 L 100 20 L 100 20 L 0 10 Z',
      'M 0 10 L 100 20 L 100 0 L 0 0 Z',
    ]);
  });

  it('pins the Others top line to the chart top', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.topPath).toBe('M 0 0 L 100 0');
  });

  function driftingOthersStats(): UsageStatsWindowStats {
    return windowStats({
      others: { sharePercent: 10, deltaPoints: null },
      trend: {
        bucket: 'day',
        points: [
          {
            start: '2026-06-01',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 50 },
            ],
            othersSharePercent: 10,
          },
          {
            // Point shares sum to 99.9, so stacking the point's own Others
            // share would land the top edge at y 0.1 rather than the chart
            // top. A fixture summing to exactly 100 leaves the pinned edge and
            // the stacked one identical and proves neither.
            start: '2026-06-02',
            models: [
              { modelId: 'a/one', sharePercent: 33.3 },
              { modelId: 'b/two', sharePercent: 56.6 },
            ],
            othersSharePercent: 10,
          },
        ],
      },
    });
  }

  it('pins the Others top line to the chart top when point shares fall short of full', () => {
    const ws = driftingOthersStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.topPath).toBe('M 0 0 L 100 0');
  });

  it('closes the Others polygon along the chart top when point shares fall short of full', () => {
    const ws = driftingOthersStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    const ys = pathYs(series.at(-1)!.path);
    expect(ys.slice(ys.length / 2)).toEqual([0, 0]);
  });

  it('returns no bands when the trend has a single point', () => {
    const ws = windowStats();
    const trend = { bucket: ws.trend.bucket, points: [ws.trend.points[0]!] };
    expect(trendSeries(trend, rankModels(ws), ws.others.sharePercent)).toEqual([]);
  });

  it('returns no bands when the trend has no points', () => {
    const ws = windowStats();
    expect(trendSeries({ bucket: 'day', points: [] }, rankModels(ws), 10)).toEqual([]);
  });

  it('renders only the Others band when no models are ranked', () => {
    const ws = windowStats();
    const series = trendSeries(ws.trend, rankModels(windowStats({ models: [] })), 10);
    expect(series.map((s) => s.label)).toEqual(['Others']);
  });

  /** A three-day trend where 'a/one' has no share on the first two days. */
  function lateEntrantStats(): UsageStatsWindowStats {
    return windowStats({
      trend: {
        bucket: 'day',
        points: [
          {
            start: '2026-06-01',
            models: [{ modelId: 'b/two', sharePercent: 90 }],
            othersSharePercent: 10,
          },
          {
            start: '2026-06-02',
            models: [{ modelId: 'b/two', sharePercent: 90 }],
            othersSharePercent: 10,
          },
          {
            start: '2026-06-03',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 50 },
            ],
            othersSharePercent: 10,
          },
        ],
      },
    });
  }

  it('omits a top-line segment where the band has no share at either end', () => {
    const ws = lateEntrantStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    // One (rank 2) stacks on Two: its upper edge is y [10, 10, 10]. Days 1-2 carry
    // no share for One, so only the segment from day 2 to day 3 is drawn.
    expect(series.find((s) => s.label === 'One')?.segments).toBe('M 50 10 L 100 10');
  });

  it('draws the whole top line of a band with a share at every point', () => {
    const ws = lateEntrantStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.find((s) => s.label === 'Two')?.segments).toBe('M 0 10 L 50 10 L 100 50');
  });

  it('breaks a top line into separate runs around a shareless stretch', () => {
    const ws = windowStats({
      trend: {
        bucket: 'day',
        points: [0, 1, 2, 3, 4].map((day) => ({
          start: `2026-06-0${String(day + 1)}`,
          models: [
            { modelId: 'b/two', sharePercent: 50 },
            ...(day === 0 || day === 4 ? [{ modelId: 'a/one', sharePercent: 40 }] : []),
          ],
          othersSharePercent: day === 0 || day === 4 ? 10 : 50,
        })),
      },
    });
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.find((s) => s.label === 'One')?.segments).toBe('M 0 10 L 25 50 M 75 50 L 100 10');
  });

  it('draws the Others top line only where Others holds a share', () => {
    const ws = windowStats({
      trend: {
        bucket: 'day',
        points: [
          {
            start: '2026-06-01',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 60 },
            ],
            othersSharePercent: 0,
          },
          {
            start: '2026-06-02',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 60 },
            ],
            othersSharePercent: 0,
          },
          {
            start: '2026-06-03',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 50 },
            ],
            othersSharePercent: 10,
          },
        ],
      },
    });
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.segments).toBe('M 50 0 L 100 0');
  });

  it('counts a trend-only model toward the Others share its band absorbs', () => {
    const ws = windowStats({
      trend: {
        bucket: 'day',
        points: [
          {
            start: '2026-06-01',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 60 },
            ],
            othersSharePercent: 0,
          },
          {
            start: '2026-06-02',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 50 },
              { modelId: 'c/gone', sharePercent: 10 },
            ],
            othersSharePercent: 0,
          },
        ],
      },
    });
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.segments).toBe('M 0 0 L 100 0');
  });

  function zeroOthersStats(): UsageStatsWindowStats {
    return windowStats({
      others: { sharePercent: 0, deltaPoints: null },
      trend: {
        bucket: 'day',
        points: [
          {
            start: '2026-06-01',
            models: [
              { modelId: 'a/one', sharePercent: 40 },
              { modelId: 'b/two', sharePercent: 60 },
            ],
            othersSharePercent: 0,
          },
          {
            // Point shares sum to 99.9: per-point rounding drift the pinned
            // topmost band must absorb when Others is omitted.
            start: '2026-06-02',
            models: [
              { modelId: 'a/one', sharePercent: 33.3 },
              { modelId: 'b/two', sharePercent: 66.6 },
            ],
            othersSharePercent: 0,
          },
        ],
      },
    });
  }

  it('omits the Others band when the window Others share is zero', () => {
    const ws = zeroOthersStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.map((s) => s.label)).toEqual(['Two', 'One']);
  });

  it('pins the topmost model band to the chart top when Others is omitted', () => {
    const ws = zeroOthersStats();
    const series = trendSeries(ws.trend, rankModels(ws), ws.others.sharePercent);
    expect(series.at(-1)?.label).toBe('One');
    expect(series.at(-1)?.topPath).toBe('M 0 0 L 100 0');
  });

  it('keeps the Others band when no models are ranked even at zero share', () => {
    const ws = zeroOthersStats();
    const series = trendSeries(ws.trend, rankModels(windowStats({ models: [] })), 0);
    expect(series.map((s) => s.label)).toEqual(['Others']);
  });
});

describe('Y_AXIS_TICKS', () => {
  it('runs from 100 down to 0 in quarters', () => {
    expect(Y_AXIS_TICKS).toEqual([100, 75, 50, 25, 0]);
  });
});

describe('xAxisTicks', () => {
  const window7 = USAGE_STATS_WINDOWS.find((w) => w.key === '7d')!;
  const window30 = USAGE_STATS_WINDOWS.find((w) => w.key === '30d')!;
  const windowAll = USAGE_STATS_WINDOWS.find((w) => w.key === 'all')!;
  const DAY_MS = 86_400_000;

  /** A day-bucket trend of `count` consecutive days from `first`. */
  function dayTrend(first: string, count: number): UsageStatsWindowStats['trend'] {
    const origin = new Date(first).getTime();
    return {
      bucket: 'day',
      points: Array.from({ length: count }, (_, index) => ({
        start: new Date(origin + index * DAY_MS).toISOString().slice(0, 10),
        models: [],
        othersSharePercent: 100,
      })),
    };
  }

  function monthTrend(starts: readonly string[]): UsageStatsWindowStats['trend'] {
    return {
      bucket: 'month',
      points: starts.map((start) => ({ start, models: [], othersSharePercent: 100 })),
    };
  }

  it('ticks a full 30-day series on its first day, weekly after it, and its last day', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-08-25', 30));
    expect(ticks.map((tick) => tick.label)).toEqual([
      'Aug 25',
      'Sep 1',
      'Sep 8',
      'Sep 15',
      'Sep 23',
    ]);
  });

  it('places each tick at its point on the band x scale', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-08-25', 30));
    expect(ticks.map((tick) => tick.position)).toEqual([0, 24.14, 48.28, 72.41, 100]);
  });

  it('drops a weekly tick within three days of the last', () => {
    // Day index 28 is a weekly tick one day before the last (29); it goes.
    const ticks = xAxisTicks(window30, dayTrend('2026-08-25', 30));
    expect(ticks.map((tick) => tick.label)).not.toContain('Sep 22');
  });

  it('tiers the first and last ticks as edges and alternates the interior ones from dense', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-08-25', 30));
    expect(ticks.map((tick) => tick.tier)).toEqual(['edge', 'dense', 'alternate', 'dense', 'edge']);
  });

  it('tiers both ticks of a 2-point series as edges', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-09-22', 2));
    expect(ticks.map((tick) => tick.tier)).toEqual(['edge', 'edge']);
  });

  it('merges the weekly tick into the last tick of an 8-point series', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-09-16', 8));
    expect(ticks.map((tick) => tick.label)).toEqual(['Sep 16', 'Sep 23']);
  });

  it('ticks both days of a 2-point series', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-09-22', 2));
    expect(ticks.map((tick) => [tick.label, tick.position])).toEqual([
      ['Sep 22', 0],
      ['Sep 23', 100],
    ]);
  });

  it('ticks what a 12-point series shorter than its 30-day window has', () => {
    const ticks = xAxisTicks(window30, dayTrend('2026-09-12', 12));
    expect(ticks.map((tick) => tick.label)).toEqual(['Sep 12', 'Sep 19', 'Sep 23']);
  });

  it('ticks every day of a 7-day window', () => {
    const ticks = xAxisTicks(window7, dayTrend('2026-09-17', 7));
    expect(ticks.map((tick) => tick.label)).toEqual([
      'Sep 17',
      'Sep 18',
      'Sep 19',
      'Sep 20',
      'Sep 21',
      'Sep 22',
      'Sep 23',
    ]);
  });

  it('ticks every month of a month series, labelled with the year', () => {
    const ticks = xAxisTicks(windowAll, monthTrend(['2026-06-01', '2026-07-01', '2026-08-01']));
    expect(ticks.map((tick) => tick.label)).toEqual(['Jun 2026', 'Jul 2026', 'Aug 2026']);
  });

  it('returns no ticks for an empty series', () => {
    expect(xAxisTicks(window30, { bucket: 'day', points: [] })).toEqual([]);
  });

  it('places the one tick of a single-point series at the left edge', () => {
    expect(xAxisTicks(window30, dayTrend('2026-09-23', 1))).toEqual([
      { label: 'Sep 23', position: 0, tier: 'edge' },
    ]);
  });

  it('tiers a 4-point month series by alternation from its first interior tick', () => {
    const ticks = xAxisTicks(
      windowAll,
      monthTrend(['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'])
    );
    expect(ticks.map((tick) => tick.tier)).toEqual(['edge', 'dense', 'alternate', 'edge']);
  });

  it('tiers a 6-point month series by alternation from its first interior tick', () => {
    const ticks = xAxisTicks(
      windowAll,
      monthTrend([
        '2026-04-01',
        '2026-05-01',
        '2026-06-01',
        '2026-07-01',
        '2026-08-01',
        '2026-09-01',
      ])
    );
    expect(ticks.map((tick) => tick.tier)).toEqual([
      'edge',
      'dense',
      'alternate',
      'dense',
      'alternate',
      'edge',
    ]);
  });

  it('echoes a bucket start with no month label rather than rendering undefined', () => {
    const ticks = xAxisTicks(windowAll, monthTrend(['2025-13-01', '2026-06-01']));
    expect(ticks[0]?.label).toBe('2025-13-01');
  });

  it('echoes a day start with no month label', () => {
    const trend = dayTrend('2026-09-22', 2);
    const ticks = xAxisTicks(window30, {
      ...trend,
      points: trend.points.map((point, index) => ({
        ...point,
        start: index === 0 ? '2026-13-05' : point.start,
      })),
    });
    expect(ticks[0]?.label).toBe('2026-13-05');
  });

  it('echoes a day start with no day part', () => {
    const trend = dayTrend('2026-09-22', 2);
    const ticks = xAxisTicks(window30, {
      ...trend,
      points: trend.points.map((point, index) => ({
        ...point,
        start: index === 0 ? '2026-09' : point.start,
      })),
    });
    expect(ticks[0]?.label).toBe('2026-09');
  });
});

describe('tickSpan', () => {
  it('names the span from the first tick to the last', () => {
    expect(
      tickSpan([
        { label: 'Aug 25', position: 0, tier: 'edge' },
        { label: 'Sep 1', position: 24.14, tier: 'dense' },
        { label: 'Sep 23', position: 100, tier: 'edge' },
      ])
    ).toBe('from Aug 25 to Sep 23');
  });

  it('is empty without ticks', () => {
    expect(tickSpan([])).toBe('');
  });
});

describe('tick character widths', () => {
  it('holds the measured mono tick face at 0.73em a character, tracking included', () => {
    // Widest measured JetBrains Mono label: "Jan 10", 0.7275em per character.
    expect(MONO_TICK_CHARACTER_EM).toBe(0.73);
  });

  it('holds the widest accessibility-widget face at 0.97em a character, tracking included', () => {
    // Widest measured widget-face label: OpenDyslexic "May 2", 0.9667em per character.
    expect(WIDGET_FACE_TICK_CHARACTER_EM).toBe(0.97);
  });
});

describe('tickLabelWidthRem', () => {
  it('sizes a label at the tick font from a width per character', () => {
    // 0.75rem type at 0.7em a character: 6 characters are 3.15rem, 8 are 4.2rem.
    expect(tickLabelWidthRem('Sep 26', 0.7)).toBe(3.15);
    expect(tickLabelWidthRem('Jun 2026', 0.7)).toBe(4.2);
  });

  it('sizes a label in the mono tick face by default', () => {
    // 6 x 0.73 x 0.75.
    expect(tickLabelWidthRem('Sep 26')).toBe(3.285);
  });
});

describe('tickThresholds', () => {
  /** At 0.7em a character: six-character labels are 3.15rem; the gap is 0.5em, 0.375rem. */
  const EM = 0.7;

  function ticksAt(positions: readonly number[]): readonly XAxisTick[] {
    const tierAt = (index: number): TickTier => {
      if (index === 0 || index === positions.length - 1) return 'edge';
      return index % 2 === 0 ? 'alternate' : 'dense';
    };
    return positions.map((position, index) => ({ label: 'Sep 26', position, tier: tierAt(index) }));
  }

  it('derives the width every tick needs from the closest pair', () => {
    // Quarter spacing. First (start-anchored) to a centred tick: 0.375 + 3.15 + 1.575
    // over 0.25 = 20.4rem, and the same at the end-anchored last; centred pairs need less.
    expect(tickThresholds(ticksAt([0, 25, 50, 75, 100]), EM).dense).toBe(20.4);
  });

  it('derives the width the alternating set needs from its own pairs', () => {
    // The set 0, 50, 100: 0.375 + 3.15 + 1.575 over 0.5 = 10.2rem.
    expect(tickThresholds(ticksAt([0, 25, 50, 75, 100]), EM).alternate).toBe(10.2);
  });

  it('derives the width the two edge labels need side by side', () => {
    // Start- and end-anchored across the whole row: 3.15 + 3.15 + 0.375.
    expect(tickThresholds(ticksAt([0, 25, 50, 75, 100]), EM).edges).toBe(6.68);
  });

  it('spaces two centred ticks by one label plus the gap', () => {
    // 45 to 55, both centred: 0.375 + 1.575 + 1.575 over 0.1 = 35.25rem, well above
    // the 5.1 / 0.45 = 11.34rem each anchored edge pair needs.
    expect(tickThresholds(ticksAt([0, 45, 55, 100]), EM).dense).toBe(35.25);
  });

  it('never asks the alternating set for more width than the full set', () => {
    // Four points: the alternating set 0, 66.67, 100 is as tight as the full set,
    // so it may show whenever the full set does.
    const thresholds = tickThresholds(ticksAt([0, 33.33, 66.67, 100]), EM);
    expect(thresholds.alternate).toBeLessThanOrEqual(thresholds.dense);
  });

  it('sizes each tick by its own label', () => {
    const ticks: readonly XAxisTick[] = [
      { label: 'Jun 2026', position: 0, tier: 'edge' },
      { label: 'Sep 2026', position: 100, tier: 'edge' },
    ];
    // Start- and end-anchored labels side by side: 4.2 + 4.2 + 0.375.
    expect(tickThresholds(ticks, EM).edges).toBe(8.78);
  });

  it('widens every threshold with a wider face', () => {
    // At 0.92em a character a six-character label is 4.14rem: the set 0, 50, 100
    // needs 0.375 + 4.14 + 2.07 over 0.5 = 13.17rem.
    expect(tickThresholds(ticksAt([0, 25, 50, 75, 100]), 0.92).alternate).toBe(13.17);
  });

  it('derives from the mono tick face by default', () => {
    expect(tickThresholds(ticksAt([0, 25, 50, 75, 100]))).toEqual(
      tickThresholds(ticksAt([0, 25, 50, 75, 100]), MONO_TICK_CHARACTER_EM)
    );
  });

  it('rounds a threshold up to the next hundredth of a rem', () => {
    // 0 to 33.33: 5.1 / 0.3333 = 15.3015..., rounded up.
    expect(tickThresholds(ticksAt([0, 33.33, 100]), EM).dense).toBe(15.31);
  });

  it('needs no width for a single tick', () => {
    expect(tickThresholds([{ label: 'Sep 26', position: 0, tier: 'edge' }], EM)).toEqual({
      edges: 0,
      alternate: 0,
      dense: 0,
    });
  });
});

describe('selectView', () => {
  const data = stats({
    text: { '7d': windowStats(), '30d': windowStats(), all: windowStats() },
    video: { all: windowStats() },
  });

  it('defaults to the first present modality and the 30d window', () => {
    const view = selectView(data, null, null);
    expect(view?.modality).toBe('text');
    expect(view?.window.key).toBe('30d');
  });

  it('honors a valid selection', () => {
    const view = selectView(data, 'text', '7d');
    expect(view?.modality).toBe('text');
    expect(view?.window.key).toBe('7d');
  });

  it('falls back to an available window when the selected one has no data for the modality', () => {
    const view = selectView(data, 'video', '30d');
    expect(view?.modality).toBe('video');
    expect(view?.window.key).toBe('all');
  });

  it('falls back to the first present modality when the selected one is absent', () => {
    const view = selectView(data, 'image', '30d');
    expect(view?.modality).toBe('text');
  });

  it('returns null when the payload has no modalities', () => {
    expect(selectView(stats({}), null, null)).toBeNull();
  });

  it('exposes the window stats for the resolved pair', () => {
    const view = selectView(data, null, null);
    expect(view?.stats.cost.avgUsd).toBe('0.0051');
  });
});

describe('dotPlotPositions', () => {
  it('places the cheapest model at 0 and the priciest at 100 on a log scale', () => {
    const positions = dotPlotPositions(rankModels(windowStats()));
    const byId = new Map(positions.map((p) => [p.modelId, p.position]));
    expect(byId.get('b/two')).toBe(0);
    expect(byId.get('a/one')).toBe(100);
  });

  it('centers a single model', () => {
    const ws = windowStats();
    const only = rankModels({ ...ws, models: [ws.models[0]!] });
    expect(dotPlotPositions(only)[0]?.position).toBe(50);
  });

  it('centers models when all costs are equal', () => {
    const ws = windowStats();
    const equal = rankModels({
      ...ws,
      models: ws.models.map((m) => ({ ...m, avgCostUsd: '0.01' })),
    });
    expect(dotPlotPositions(equal).every((p) => p.position === 50)).toBe(true);
  });

  it('pins non-positive costs to the left edge', () => {
    const ws = windowStats();
    const withZero = rankModels({
      ...ws,
      models: [{ ...ws.models[0]!, avgCostUsd: '0' }, ws.models[1]!],
    });
    const byId = new Map(dotPlotPositions(withZero).map((p) => [p.modelId, p.position]));
    expect(byId.get('a/one')).toBe(0);
  });

  it('orders entries by average cost descending', () => {
    const positions = dotPlotPositions(rankModels(windowStats()));
    expect(positions.map((p) => p.modelId)).toEqual(['a/one', 'b/two']);
  });

  it('breaks cost ties by modelId ascending', () => {
    const ws = windowStats();
    const tied = rankModels({
      ...ws,
      models: ws.models.map((m) => ({ ...m, avgCostUsd: '0.01' })),
    });
    expect(dotPlotPositions(tied).map((p) => p.modelId)).toEqual(['a/one', 'b/two']);
  });

  it('keeps each color keyed to the model share rank after reordering', () => {
    const positions = dotPlotPositions(rankModels(windowStats()));
    const byId = new Map(positions.map((p) => [p.modelId, p.color]));
    expect(byId.get('b/two')).toBe('var(--chart-1)');
    expect(byId.get('a/one')).toBe('var(--chart-2)');
  });
});
