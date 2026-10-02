import {
  MODALITIES,
  USAGE_STATS_WINDOWS,
  type Modality,
  type PublicUsageStats,
  type UsageStatsWindow,
  type UsageStatsWindowKey,
  type UsageStatsWindowStats,
} from '@hushbox/shared';

type Trend = UsageStatsWindowStats['trend'];
type TrendPoint = Trend['points'][number];

/**
 * One vertex of a stacked-area edge. The x position and the source point ride
 * with the y value so the three edges a band is drawn from stay aligned by
 * construction rather than by parallel arrays sharing an index.
 */
interface EdgePoint {
  readonly point: TrendPoint;
  readonly x: number;
  readonly y: number;
}

export interface RankedModel {
  readonly rank: number;
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly sharePercent: number;
  readonly deltaPoints: number | null;
  readonly avgCostUsd: string;
  readonly color: string;
}

export interface TrendBand {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly path: string;
  /** Open polyline along the band's whole upper edge. */
  readonly topPath: string;
  /**
   * The upper edge with every segment dropped whose two ends both carry no
   * share for this band: the stroked top line, so a model absent for a stretch
   * draws no line along the band beneath it. Empty when the band never has a share.
   */
  readonly segments: string;
}

/**
 * Which ticks show as the plot narrows: edge ticks (the first and last) always,
 * alternate ticks while the alternating set fits, dense ticks while every tick fits.
 */
export type TickTier = 'edge' | 'alternate' | 'dense';

export interface XAxisTick {
  readonly label: string;
  /** Horizontal position on the band x scale, 0 to 100. */
  readonly position: number;
  readonly tier: TickTier;
}

/**
 * Plot widths, in rem: below `edges` the last label drops to a second line;
 * below `alternate` and `dense` those tiers hide.
 */
export interface TickThresholds {
  readonly edges: number;
  readonly alternate: number;
  readonly dense: number;
}

/** Percent-axis labels, top to bottom; the dashed gridlines sit at the interior three. */
export const Y_AXIS_TICKS = [100, 75, 50, 25, 0] as const;

export interface DotPlotEntry extends RankedModel {
  /** Horizontal position on the log-scale axis, 0 (cheapest) to 100 (priciest). */
  readonly position: number;
}

/** Neutral paint for the aggregated Others bucket, never a chart series colour. */
export const OTHERS_COLOR = 'color-mix(in srgb, var(--foreground-muted) 55%, var(--background))';

/**
 * Series colours by rank: the five chart tokens, then the teal, magenta and
 * slate model tokens, repeating from rank 9.
 */
const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--model-1)',
  'var(--model-7)',
  'var(--model-6)',
] as const;

/**
 * Modalities present in the payload, in the canonical MODALITIES order. A
 * modality key with an empty window record carries nothing renderable and is
 * treated as absent.
 */
export function availableModalities(data: PublicUsageStats): Modality[] {
  return MODALITIES.filter((modality) => {
    const windows = data.modalities[modality];
    return windows !== undefined && Object.keys(windows).length > 0;
  });
}

export function availableWindows(
  data: PublicUsageStats,
  modality: Modality
): readonly UsageStatsWindow[] {
  return USAGE_STATS_WINDOWS.filter((window) => data.modalities[modality]?.[window.key]);
}

export function defaultWindowKey(windows: readonly UsageStatsWindow[]): UsageStatsWindowKey {
  const thirty = windows.find((window) => window.key === '30d');
  if (thirty !== undefined) return thirty.key;
  const first = windows[0];
  if (first === undefined) throw new Error('defaultWindowKey requires at least one window');
  return first.key;
}

interface StatsView {
  readonly modality: Modality;
  readonly window: UsageStatsWindow;
  readonly stats: UsageStatsWindowStats;
}

/**
 * Resolves the (modality, window) pair to render, falling back gracefully:
 * an absent selected modality yields the first present one, and a selected
 * window with no data for that modality yields the modality's default
 * window. Null only when the payload carries no modalities at all.
 */
export function selectView(
  data: PublicUsageStats,
  selectedModality: Modality | null,
  selectedWindowKey: UsageStatsWindowKey | null
): StatsView | null {
  const modalities = availableModalities(data);
  const fallbackModality = modalities[0];
  if (fallbackModality === undefined) return null;
  const modality =
    selectedModality !== null && modalities.includes(selectedModality)
      ? selectedModality
      : fallbackModality;

  const windows = availableWindows(data, modality);
  const windowKey =
    selectedWindowKey !== null && windows.some((w) => w.key === selectedWindowKey)
      ? selectedWindowKey
      : defaultWindowKey(windows);
  const window = windows.find((w) => w.key === windowKey);
  const stats = data.modalities[modality]?.[windowKey];
  // Unreachable-by-construction guard: windowKey is drawn from `windows`, and
  // availableWindows only lists keys with data. Defensive only.
  /* v8 ignore next 3 */
  if (window === undefined || stats === undefined) {
    throw new Error('selectView resolved a window without data');
  }
  return { modality, window, stats };
}

export function colorForRank(rank: number): string {
  const color = SERIES_COLORS[(rank - 1) % SERIES_COLORS.length];
  if (color === undefined) {
    throw new Error(`colorForRank requires a positive integer rank, got ${String(rank)}`);
  }
  return color;
}

export function rankModels(stats: UsageStatsWindowStats): RankedModel[] {
  return stats.models
    .toSorted((a, b) => b.sharePercent - a.sharePercent)
    .map((model, index) => ({ ...model, rank: index + 1, color: colorForRank(index + 1) }));
}

/** Display formatting only — the USD string is never fed into arithmetic. */
export function formatUsd(usd: string): string {
  const trimmed = usd.includes('.') ? usd.replace(/0+$/, '').replace(/\.$/, '') : usd;
  return `$${trimmed}`;
}

export function formatDelta(deltaPoints: number): string {
  return `${deltaPoints >= 0 ? '+' : ''}${deltaPoints.toFixed(1)}`;
}

export function formatShare(sharePercent: number): string {
  return `${sharePercent.toFixed(1)}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A model absent from a trend point contributes no share there. */
function shareAt(point: TrendPoint, modelId: string): number {
  return point.models.find((m) => m.modelId === modelId)?.sharePercent ?? 0;
}

/** The Others band's share at a point: its own bucket plus every trend-only model it absorbs. */
function othersShareAt(point: TrendPoint, ranked: readonly RankedModel[]): number {
  const absorbed = point.models
    .filter((m) => !ranked.some((model) => model.modelId === m.modelId))
    .reduce((sum, m) => sum + m.sharePercent, 0);
  return point.othersSharePercent + absorbed;
}

/** The edge's segments whose two ends are not both shareless, as runs of M/L commands. */
function shareSegments(edge: readonly EdgePoint[], shareOf: (point: TrendPoint) => number): string {
  const commands: string[] = [];
  let inRun = false;
  for (const [index, vertex] of edge.entries()) {
    const next = edge[index + 1];
    const segmentAfter =
      next !== undefined && (shareOf(vertex.point) > 0 || shareOf(next.point) > 0);
    const at = `${String(vertex.x)} ${String(round2(100 - vertex.y))}`;
    if (inRun) commands.push(`L ${at}`);
    else if (segmentAfter) commands.push(`M ${at}`);
    inRun = segmentAfter;
  }
  return commands.join(' ');
}

/**
 * 100%-stacked-area bands over the trend, bottom-up in rank order with the
 * Others band closing the stack. The Others band's upper edge is pinned to
 * the chart top so per-point rounding drift can never leave a sliver of
 * background above the stack. A model absent from a point contributes zero
 * share there; trend-only model ids not in the ranked list are absorbed by
 * the pinned Others band. Fewer than two points cannot draw an area, so the
 * series is empty and the chart shows its not-enough-data placeholder.
 *
 * A zero-share Others is omitted entirely (band and, downstream, its legend
 * entry) to mirror the ranked list's suppression rule; the topmost model band
 * then inherits the chart-top pin so rounding drift still cannot leave a
 * sliver above the stack. With no ranked models the Others band stays as the
 * only thing left to draw.
 */
export function trendSeries(
  trend: Trend,
  ranked: readonly RankedModel[],
  othersSharePercent: number
): TrendBand[] {
  const points = trend.points;
  if (points.length < 2) return [];

  const topPath = (edge: readonly EdgePoint[]): string =>
    edge
      .map(
        (vertex, index) =>
          `${index === 0 ? 'M' : 'L'} ${String(vertex.x)} ${String(round2(100 - vertex.y))}`
      )
      .join(' ');

  const bandPath = (lowerEdge: readonly EdgePoint[], upperEdge: readonly EdgePoint[]): string => {
    const backward = upperEdge
      .toReversed()
      .map((vertex) => `L ${String(vertex.x)} ${String(round2(100 - vertex.y))}`)
      .join(' ');
    return `${topPath(lowerEdge)} ${backward} Z`;
  };

  const baseline: readonly EdgePoint[] = points.map((point, index) => ({
    point,
    x: round2((index * 100) / (points.length - 1)),
    y: 0,
  }));
  const chartTop: readonly EdgePoint[] = baseline.map((vertex) => ({ ...vertex, y: 100 }));
  const includeOthers = othersSharePercent !== 0 || ranked.length === 0;

  let lower = baseline;
  const bands: TrendBand[] = [];

  for (const [modelIndex, model] of ranked.entries()) {
    const pinned = !includeOthers && modelIndex === ranked.length - 1;
    const upper = pinned
      ? chartTop
      : lower.map((vertex) => ({
          ...vertex,
          y: vertex.y + shareAt(vertex.point, model.modelId),
        }));
    bands.push({
      id: model.modelId,
      label: model.displayName,
      color: model.color,
      path: bandPath(lower, upper),
      topPath: topPath(upper),
      segments: shareSegments(upper, (point) => shareAt(point, model.modelId)),
    });
    lower = upper;
  }

  if (includeOthers) {
    bands.push({
      id: 'others',
      label: 'Others',
      color: OTHERS_COLOR,
      path: bandPath(lower, chartTop),
      topPath: topPath(chartTop),
      segments: shareSegments(chartTop, (point) => othersShareAt(point, ranked)),
    });
  }

  return bands;
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split('-');
  const label = MONTH_LABELS[Number(month) - 1];
  // A bucket start outside `YYYY-MM-...` has no month label; the raw value on
  // the axis beats the string "undefined".
  if (label === undefined || year === undefined) return isoDate;
  return `${label} ${year}`;
}

function dayLabel(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  const label = MONTH_LABELS[Number(month) - 1];
  if (label === undefined || day === undefined) return isoDate;
  return `${label} ${String(Number(day))}`;
}

/** Edges first and last; interior ticks alternate dense, alternate, ... from the first. */
function tickTier(tickIndex: number, count: number): TickTier {
  if (tickIndex === 0 || tickIndex === count - 1) return 'edge';
  return tickIndex % 2 === 0 ? 'alternate' : 'dense';
}

/** Days between weekly ticks on a day series longer than a week. */
const WEEK = 7;
/** A weekly tick this close to the last day is dropped so the two labels never collide. */
const LAST_TICK_CLEARANCE = 3;

/**
 * Dated ticks under the plot, on the same x scale as the bands. A month
 * series and a series of a week or less tick every point; a longer day series
 * ticks its first day, every seventh day after it and its last day, dropping a
 * weekly tick within three days of the last. A series shorter than its window
 * ticks what it has. The first and last ticks are edges; the interior ones
 * alternate dense, alternate, dense, ... from the first interior tick.
 */
export function xAxisTicks(window: UsageStatsWindow, trend: Trend): readonly XAxisTick[] {
  const points = trend.points;
  const lastIndex = points.length - 1;
  const everyPoint = trend.bucket === 'month' || (window.days !== null && window.days <= WEEK);
  const format = trend.bucket === 'month' ? monthLabel : dayLabel;
  const ticked = points
    .map((point, index) => ({ point, index }))
    .filter(
      ({ index }) =>
        everyPoint ||
        index === 0 ||
        index === lastIndex ||
        (index % WEEK === 0 && lastIndex - index > LAST_TICK_CLEARANCE)
    );
  return ticked.map(({ point, index }, tickIndex) => ({
    label: format(point.start),
    position: lastIndex === 0 ? 0 : round2((index * 100) / lastIndex),
    tier: tickTier(tickIndex, ticked.length),
  }));
}

/** Tick type is 0.75rem with 0.1em of tracking. */
const TICK_FONT_REM = 0.75;
/**
 * The widest width per character, tracking included, measured in Chromium over
 * every label `xAxisTicks` can produce ("MMM D" for days 1 to 31 and "MMM YYYY"
 * for 2000 to 2099, in all twelve months), at the tick styling, at 100%, 124% and
 * 141% text, with 12px and 12.75px tick type. Rounded up to the hundredth.
 * Mono: JetBrains Mono, widest "Jan 10" at 0.7275em. Widget face: the widest of
 * Atkinson, Lexend and OpenDyslexic, which is OpenDyslexic (85% size-adjust),
 * widest "May 2" at 0.9667em. A new widget face or tick font means measuring again.
 */
export const MONO_TICK_CHARACTER_EM = 0.73;
export const WIDGET_FACE_TICK_CHARACTER_EM = 0.97;
/** The least space kept between two visible tick labels, in the tick font's em. */
const TICK_GAP_EM = 0.5;

/** A tick label's rendered width in rem, from its character count at the tick font. */
export function tickLabelWidthRem(label: string, characterEm = MONO_TICK_CHARACTER_EM): number {
  return Math.round(label.length * characterEm * TICK_FONT_REM * 10_000) / 10_000;
}

/**
 * How much of a label sits before its tick: none for the first (anchored at its
 * start), all for the last (anchored at its end), half for a centred interior tick.
 */
function leadingShare(index: number, count: number): number {
  if (index === 0) return 0;
  return index === count - 1 ? 1 : 0.5;
}

/** The narrowest plot, in rem, on which the given ticks keep the gap between neighbours. */
function widthNeededRem(
  ticks: readonly XAxisTick[],
  all: readonly XAxisTick[],
  characterEm: number
): number {
  const gapRem = TICK_GAP_EM * TICK_FONT_REM;
  let needed = 0;
  for (const [index, tick] of ticks.entries()) {
    const next = ticks[index + 1];
    if (next === undefined) break;
    const trailing =
      tickLabelWidthRem(tick.label, characterEm) *
      (1 - leadingShare(all.indexOf(tick), all.length));
    const leading =
      tickLabelWidthRem(next.label, characterEm) * leadingShare(all.indexOf(next), all.length);
    const span = (next.position - tick.position) / 100;
    needed = Math.max(needed, (gapRem + trailing + leading) / span);
  }
  // Rounded to a millionth first so float noise never pushes an exact value up a step.
  return Math.ceil(Math.round(needed * 100 * 1_000_000) / 1_000_000) / 100;
}

/**
 * The plot widths below which the last label drops a line and each interior
 * tier hides, derived from the label widths at the tick font and the start- and
 * end-anchored edge ticks. The alternating set never needs more than the full
 * set, so it shows whenever all do.
 */
export function tickThresholds(
  ticks: readonly XAxisTick[],
  characterEm = MONO_TICK_CHARACTER_EM
): TickThresholds {
  const edges = widthNeededRem(
    ticks.filter((tick) => tick.tier === 'edge'),
    ticks,
    characterEm
  );
  const dense = widthNeededRem(ticks, ticks, characterEm);
  const alternate = widthNeededRem(
    ticks.filter((tick) => tick.tier !== 'dense'),
    ticks,
    characterEm
  );
  return { edges, alternate: Math.min(alternate, dense), dense };
}

/** The dated span the ticks cover, as the chart's accessible name states it; empty with no ticks. */
export function tickSpan(ticks: readonly XAxisTick[]): string {
  const first = ticks[0];
  const last = ticks.at(-1);
  if (first === undefined || last === undefined) return '';
  return `from ${first.label} to ${last.label}`;
}

/**
 * Log-scale horizontal positions for the per-model cost dot plot. Costs are
 * parsed as numbers for positioning only, never for money arithmetic.
 * Non-positive costs have no log position and pin to the left edge. Rows are
 * ordered priciest-first (modelId breaks ties) while each color stays keyed
 * to the model's share rank, so the paint matches the share views.
 */
export function dotPlotPositions(ranked: readonly RankedModel[]): DotPlotEntry[] {
  const logs = ranked
    .map((model) => Number.parseFloat(model.avgCostUsd))
    .filter((value) => value > 0)
    .map((value) => Math.log(value));
  const min = Math.min(...logs);
  const max = Math.max(...logs);

  return ranked
    .map((model) => {
      const value = Number.parseFloat(model.avgCostUsd);
      if (value <= 0) return { ...model, position: 0 };
      if (max === min) return { ...model, position: 50 };
      return { ...model, position: round2(((Math.log(value) - min) / (max - min)) * 100) };
    })
    .toSorted((a, b) => {
      const costDiff = Number.parseFloat(b.avgCostUsd) - Number.parseFloat(a.avgCostUsd);
      if (costDiff !== 0) return costDiff;
      if (a.modelId === b.modelId) return 0;
      return a.modelId < b.modelId ? -1 : 1;
    });
}
