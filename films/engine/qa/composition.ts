import { FPS } from '../time/grid.js';

import { at } from './at.js';
import { COLOR_CHANNELS, pixelLuma, requireRaster } from './raster.js';

import type { Raster } from './raster.js';

/** The layout turnover reads: an 8 × 8 grid of blocks' mean luma. */
const LAYOUT_GRID = 8;
/** A second counts as changed when its layout moved more than this many grey levels from one second earlier. */
const TURNOVER_LEVELS = 15;
/** The span turnover counts changed seconds over. */
const WINDOW_SECONDS = 10;
/** Travel's grid of RGB cell means across a portrait frame: 9 columns by 16 rows. */
const TRAVEL_COLUMNS = 9;
const TRAVEL_ROWS = 16;
/** Travel samples the picture on a 1/30 s grid. */
const TRAVEL_STEP = FPS / 30;
/** Travel compares frames this far apart. */
const TRAVEL_SPAN_SECONDS = 2;
const TRAVEL_SPAN_SAMPLES = (TRAVEL_SPAN_SECONDS * FPS) / TRAVEL_STEP;

/** The changed seconds among the one-second comparisons from `fromSecond` to `toSecond`. */
export interface TurnoverWindow {
  fromSecond: number;
  toSecond: number;
  changedSeconds: number;
}

/**
 * Composition turnover: second k is changed when its layout moved more than 15
 * grey levels from second k − 1. A piece whose one-second comparisons fill a
 * 10 s window reports every full window stepped by 1 s; a shorter one reports a
 * single window over the whole piece, marked `wholePiece`.
 */
export interface Turnover {
  windows: TurnoverWindow[];
  lowest: TurnoverWindow;
  wholePiece: boolean;
}

/** Travel: the median of net change over churn across every 2 s span, or why the piece holds none. */
export type Travel = { median: number; spans: number } | { absent: string };

/** What the composition measure reads of a piece: reported, never gated. */
export interface CompositionReport {
  durationSeconds: number;
  turnover: Turnover;
  travel: Travel;
}

/** Reads a piece's frames in order and reports its composition turnover and travel. */
export interface CompositionMeter {
  add: (frame: number, raster: Raster) => void;
  report: () => CompositionReport;
}

/**
 * Each cell's mean of `valueOf(offset)` over a `columns` × `rows` grid, cells
 * row by row, `values` per cell.
 */
function gridMeans(
  raster: Raster,
  { columns, rows, values }: { columns: number; rows: number; values: number },
  valueOf: (offset: number, value: number) => number
): Float64Array {
  requireRaster(raster);
  const { width, height, channels } = raster;
  const sums = new Float64Array(columns * rows * values);
  const counts = new Float64Array(columns * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * rows) / height);
    for (let x = 0; x < width; x++) {
      const cell = row * columns + Math.floor((x * columns) / width);
      const offset = (y * width + x) * channels;
      counts[cell] = at(counts, cell) + 1;
      for (let value = 0; value < values; value++) {
        const index = cell * values + value;
        sums[index] = at(sums, index) + valueOf(offset, value);
      }
    }
  }
  return sums.map((sum, index) => sum / at(counts, Math.floor(index / values)));
}

/**
 * Each block's mean BT.709 luma, full range on the 0–255 scale, over an 8 × 8
 * grid. Full range is what the research instrument read: ffmpeg's `gray`
 * output expands the stored limited-range Y, so our references' numbers
 * compare with these.
 */
export function layoutMeans(raster: Raster): Float64Array {
  const { data } = raster;
  return gridMeans(raster, { columns: LAYOUT_GRID, rows: LAYOUT_GRID, values: 1 }, (offset) =>
    pixelLuma(data, offset)
  );
}

/** Each cell's mean of each colour channel over travel's 9-column, 16-row grid. */
export function cellMeans(raster: Raster): Float64Array {
  const { data } = raster;
  return gridMeans(
    raster,
    { columns: TRAVEL_COLUMNS, rows: TRAVEL_ROWS, values: COLOR_CHANNELS },
    (offset, channel) => at(data, offset + channel)
  );
}

/** Samples of `size` means each, held end to end. */
interface Samples {
  size: number;
  count: number;
  means: number[];
}

function samples(size: number): Samples {
  return { size, count: 0, means: [] };
}

function record(into: Samples, means: Float64Array): void {
  into.means.push(...means);
  into.count += 1;
}

/** The mean absolute difference between samples `a` and `b`. */
function distance({ size, means }: Samples, a: number, b: number): number {
  let sum = 0;
  for (let index = 0; index < size; index++) {
    sum += Math.abs(at(means, a * size + index) - at(means, b * size + index));
  }
  return sum / size;
}

function turnoverOf(layouts: Samples): Turnover {
  const compared = Math.max(0, layouts.count - 1);
  const changed = Array.from(
    { length: compared },
    (_, index) => distance(layouts, index + 1, index) > TURNOVER_LEVELS
  );
  const count = (fromSecond: number): TurnoverWindow => {
    const toSecond = Math.min(compared, fromSecond + WINDOW_SECONDS);
    return {
      fromSecond,
      toSecond,
      changedSeconds: changed.slice(fromSecond, toSecond).filter(Boolean).length,
    };
  };
  const wholePiece = compared < WINDOW_SECONDS;
  const first = count(0);
  const windows = [
    first,
    ...Array.from({ length: Math.max(0, compared - WINDOW_SECONDS) }, (_, index) =>
      count(index + 1)
    ),
  ];
  let lowest = first;
  for (const window of windows) {
    if (window.changedSeconds < lowest.changedSeconds) {
      lowest = window;
    }
  }
  return { windows, lowest, wholePiece };
}

/** The lower of the two middle values when their count is even: the statistic the references were measured with. */
function lowerMedian(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return at(sorted, Math.floor((sorted.length - 1) / 2));
}

function travelOf(cells: Samples, durationSeconds: number): Travel {
  const spans = cells.count - TRAVEL_SPAN_SAMPLES;
  if (spans < 1) {
    return {
      absent: `the piece is ${durationSeconds.toFixed(1)} s and its last frame falls short of ${String(TRAVEL_SPAN_SECONDS)} s, so it holds no ${String(TRAVEL_SPAN_SECONDS)} s span`,
    };
  }
  const churnBefore = [0];
  for (let index = 1; index < cells.count; index++) {
    churnBefore.push(at(churnBefore, index - 1) + distance(cells, index, index - 1));
  }
  const ratios = Array.from({ length: spans }, (_, start) => {
    const end = start + TRAVEL_SPAN_SAMPLES;
    const churn = at(churnBefore, end) - at(churnBefore, start);
    return churn > 0 ? distance(cells, end, start) / churn : 0;
  });
  return { median: lowerMedian(ratios), spans };
}

/**
 * A meter a piece's frames are added to in order from frame 0. It keeps only
 * the samples the measures read: each whole second's layout and each 1/30 s
 * frame's cell means.
 */
export function compositionMeter(): CompositionMeter {
  const layouts = samples(LAYOUT_GRID * LAYOUT_GRID);
  const cells = samples(TRAVEL_COLUMNS * TRAVEL_ROWS * COLOR_CHANNELS);
  let frames = 0;
  return {
    add(frame, raster) {
      if (frame !== frames) {
        throw new RangeError(
          `the composition meter reads frames in order: expected frame ${String(frames)}, got frame ${String(frame)}`
        );
      }
      requireRaster(raster);
      if (frame % FPS === 0) {
        record(layouts, layoutMeans(raster));
      }
      if (frame % TRAVEL_STEP === 0) {
        record(cells, cellMeans(raster));
      }
      frames += 1;
    },
    report() {
      if (frames === 0) {
        throw new RangeError('the composition meter was given no frames to report on');
      }
      const durationSeconds = frames / FPS;
      return {
        durationSeconds,
        turnover: turnoverOf(layouts),
        travel: travelOf(cells, durationSeconds),
      };
    },
  };
}

function windowSpan({ fromSecond, toSecond }: TurnoverWindow): string {
  return `${String(fromSecond)}–${String(toSecond)} s`;
}

/** The report as the lines `verify` and `take` print: turnover, then travel. */
export function compositionLines({
  durationSeconds,
  turnover,
  travel,
}: CompositionReport): string[] {
  const { lowest } = turnover;
  const turnoverLine = turnover.wholePiece
    ? `whole piece, ${durationSeconds.toFixed(1)} s, one window ${windowSpan(lowest)} with ${String(lowest.changedSeconds)} changed seconds`
    : `lowest ${String(WINDOW_SECONDS)} s window ${windowSpan(lowest)} with ${String(lowest.changedSeconds)} changed seconds; every window: ${turnover.windows
        .map((window) => `${windowSpan(window)} ${String(window.changedSeconds)}`)
        .join(', ')}`;
  const travelLine =
    'absent' in travel
      ? `absent, ${travel.absent}`
      : `median net change over churn ${travel.median.toFixed(2)} across ${String(travel.spans)} spans of ${String(TRAVEL_SPAN_SECONDS)} s`;
  return [
    `composition turnover (reported, not gated): ${turnoverLine}`,
    `composition travel (reported, not gated): ${travelLine}`,
  ];
}
