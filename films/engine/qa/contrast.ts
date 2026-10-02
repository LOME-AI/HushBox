import { at } from './at.js';
import { gateResult } from './gate.js';
import { lowestBy } from './pick.js';
import { percentile, relativeLuminance, requireRaster } from './raster.js';
import { isSmallDifference, largestChange, smallDifferenceNote } from './small-difference.js';

import type { TextBox } from '../look/contract.js';
import type { GateFailure, GateResult } from './gate.js';
import type { Raster } from './raster.js';
import type { PixelDifference } from './small-difference.js';

/** WCAG 2.2's minimum contrast for text. */
const MIN_CONTRAST = 4.5;
/** The background is judged at the end nearer the text: this percentile from that end. */
const BACKGROUND_PERCENTILE = 95;
/** A changed pixel is glyph core when its luminance moves at least this share of the box's largest move. */
const CORE_SHARE = 0.5;

/** One probe frame rendered with its text and again with `hideText`, and the boxes the look reported. */
export interface TextPair {
  frame: number;
  boxes: readonly TextBox[];
  text: Raster;
  hidden: Raster;
}

/** WCAG 2.2's contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function requirePair({ frame, text, hidden }: TextPair): void {
  requireRaster(text);
  requireRaster(hidden);
  if (text.width !== hidden.width || text.height !== hidden.height) {
    throw new RangeError(
      `frame ${String(frame)}: the text and hidden-text renders differ in size, ${String(text.width)}×${String(text.height)} against ${String(hidden.width)}×${String(hidden.height)}`
    );
  }
}

function luminanceAt({ data, channels, width }: Raster, column: number, row: number): number {
  const offset = (row * width + column) * channels;
  return relativeLuminance(at(data, offset), at(data, offset + 1), at(data, offset + 2));
}

/** The pixel columns and rows a box covers any part of, clipped to the frame. */
function pixelSpan(
  { box }: TextBox,
  { width, height }: Raster
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.max(0, Math.floor(box.x)),
    right: Math.min(width, Math.ceil(box.x + box.width)),
    top: Math.max(0, Math.floor(box.y)),
    bottom: Math.min(height, Math.ceil(box.y + box.height)),
  };
}

/** One copy box's contrast on one probe frame; null when no pixel of its box changes inside the frame. */
export interface ClaimContrast {
  frame: number;
  id: string;
  ratio: number | null;
}

function boxContrast({ text, hidden }: TextPair, box: TextBox): number | null {
  const { left, right, top, bottom } = pixelSpan(box, hidden);
  const background: number[] = [];
  const changed: { text: number; move: number }[] = [];
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      const behind = luminanceAt(hidden, column, row);
      background.push(behind);
      if (largestChange(text, hidden, row * hidden.width + column) > 0) {
        const drawn = luminanceAt(text, column, row);
        changed.push({ text: drawn, move: Math.abs(drawn - behind) });
      }
    }
  }
  if (changed.length === 0) {
    return null;
  }
  const largest = Math.max(...changed.map(({ move }) => move));
  const core = changed.filter(({ move }) => move >= largest * CORE_SHARE).map(({ text: l }) => l);
  const glyphs = percentile(core, 50);
  const worst =
    glyphs >= percentile(background, 50)
      ? percentile(background, BACKGROUND_PERCENTILE)
      : percentile(background, 100 - BACKGROUND_PERCENTILE);
  return contrastRatio(glyphs, worst);
}

/**
 * The contrast of each copy box on one probe frame, from the frame as delivered
 * and again with `hideText`: the text's luminance is the median of the glyph
 * core, the pixels inside the box that change most between the two, and the
 * background is the hidden-text render inside the box at its 95th percentile
 * from the text's side (the bright end behind light text, the dark end behind
 * dark text).
 */
export function measureContrast(pair: TextPair): ClaimContrast[] {
  requirePair(pair);
  return pair.boxes
    .filter(({ role }) => role !== 'imagery')
    .map((box) => ({ frame: pair.frame, id: box.id, ratio: boxContrast(pair, box) }));
}

function where({ frame, id }: ClaimContrast): string {
  return `frame ${String(frame)}, text ${JSON.stringify(id)}`;
}

function claimFailure(filmId: string, measure: ClaimContrast): GateFailure | null {
  if (measure.ratio === null || (Number.isFinite(measure.ratio) && measure.ratio >= MIN_CONTRAST)) {
    return null;
  }
  return {
    filmId,
    rule: 'contrast',
    at: where(measure),
    detail: `${measure.ratio.toFixed(2)}:1 against the background inside its box, below ${String(MIN_CONTRAST)}:1`,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * Contrast: each copy box's text against the background inside it is at least
 * 4.5:1 (WCAG 2.2), on every probe frame that holds copy. A box in which no
 * pixel changes cannot be measured, and is the containment gate's to fail.
 */
export function contrastGate(
  filmId: string,
  frames: readonly (readonly ClaimContrast[])[]
): GateResult {
  const measures = frames.flat();
  const failures = measures.flatMap((measure) => claimFailure(filmId, measure) ?? []);
  const ratios = measures.flatMap(({ frame, id, ratio }) =>
    ratio === null ? [] : [{ frame, id, ratio }]
  );
  const lowest = lowestBy(ratios, ({ ratio }) => ratio);
  const boxes = `${plural(measures.length, 'copy box', 'copy boxes')} on ${plural(frames.length, 'probe frame', 'probe frames')}`;
  let measured: string;
  if (measures.length === 0) {
    measured = 'no probe frame holds copy text';
  } else if (lowest === null) {
    measured = `${boxes}; none could be measured`;
  } else {
    measured = `${boxes}; lowest contrast ${lowest.ratio.toFixed(2)}:1 (${where(lowest)})`;
  }
  return gateResult('contrast', failures, [measured]);
}

/** Where one probe frame's text and hidden-text renders differ, against the boxes the look reported. */
export interface FrameContainment {
  frame: number;
  boxes: number;
  differing: number;
  /** Differing pixels outside every reported box. */
  strays: number;
  /** The largest change on any colour channel among the stray pixels; 0 when there are none. */
  strayLargest: number;
  /** The smallest area holding every stray pixel; null when there are none. */
  strayBounds: { x: number; y: number; width: number; height: number } | null;
  /** The ids of the boxes no differing pixel falls in. */
  empty: string[];
}

type PixelSpan = ReturnType<typeof pixelSpan>;

/** Counts a differing pixel into every box covering it; false when none does. */
function countIntoBoxes(
  spans: readonly PixelSpan[],
  hits: number[],
  column: number,
  row: number
): boolean {
  let inside = false;
  for (const [index, { left, right, top, bottom }] of spans.entries()) {
    if (column >= left && column < right && row >= top && row < bottom) {
      inside = true;
      hits[index] = at(hits, index) + 1;
    }
  }
  return inside;
}

/** The smallest area holding every pixel added to it. */
function areaAccumulator(): {
  add: (column: number, row: number) => void;
  area: () => FrameContainment['strayBounds'];
} {
  let span: PixelSpan | null = null;
  return {
    add(column, row) {
      span = {
        left: Math.min(span?.left ?? column, column),
        right: Math.max(span?.right ?? column + 1, column + 1),
        top: Math.min(span?.top ?? row, row),
        bottom: Math.max(span?.bottom ?? row + 1, row + 1),
      };
    },
    area() {
      const held: PixelSpan | null = span;
      return held === null
        ? null
        : {
            x: held.left,
            y: held.top,
            width: held.right - held.left,
            height: held.bottom - held.top,
          };
    },
  };
}

/**
 * Compares a probe frame's text and hidden-text renders, both with the post
 * chain skipped, pixel by pixel against every box the look reported: a pixel
 * belongs to a box when the box covers any part of it.
 */
export function measureContainment(pair: TextPair): FrameContainment {
  requirePair(pair);
  const { text, hidden, boxes } = pair;
  const spans = boxes.map((box) => pixelSpan(box, hidden));
  const hits = boxes.map(() => 0);
  const strayArea = areaAccumulator();
  let differing = 0;
  let strays = 0;
  let strayLargest = 0;
  for (let row = 0; row < hidden.height; row++) {
    for (let column = 0; column < hidden.width; column++) {
      const change = largestChange(text, hidden, row * hidden.width + column);
      if (change > 0) {
        differing += 1;
        if (!countIntoBoxes(spans, hits, column, row)) {
          strays += 1;
          strayLargest = Math.max(strayLargest, change);
          strayArea.add(column, row);
        }
      }
    }
  }
  return {
    frame: pair.frame,
    boxes: boxes.length,
    differing,
    strays,
    strayLargest,
    strayBounds: strayArea.area(),
    empty: boxes.filter((_, index) => hits[index] === 0).map(({ id }) => id),
  };
}

function strayDifference({ strays, strayLargest }: FrameContainment): PixelDifference {
  return { pixels: strays, largest: strayLargest };
}

/** The frame's note when its only stray pixels are a small difference the gate passes; null otherwise. */
function smallStrays(measure: FrameContainment): string | null {
  const difference = strayDifference(measure);
  return measure.strays > 0 && isSmallDifference(difference)
    ? smallDifferenceNote(measure.frame, difference)
    : null;
}

function containmentFailures(filmId: string, measure: FrameContainment): GateFailure[] {
  const frame = `frame ${String(measure.frame)}`;
  if (measure.boxes > 0 && measure.differing === 0) {
    return [
      {
        filmId,
        rule: 'hide-text',
        at: frame,
        detail: `the frame reports ${plural(measure.boxes, 'text box', 'text boxes')}, yet no pixel differs between the text and hidden-text renders; the look draws its text whatever hideText says`,
      },
    ];
  }
  const failures: GateFailure[] = [];
  const { strayBounds: stray } = measure;
  if (stray !== null && !isSmallDifference(strayDifference(measure))) {
    failures.push({
      filmId,
      rule: 'text-outside-box',
      at: frame,
      detail: `${plural(measure.strays, 'pixel differs', 'pixels differ')} between the text and hidden-text renders outside every reported box, within x ${String(stray.x)}–${String(stray.x + stray.width)}, y ${String(stray.y)}–${String(stray.y + stray.height)}; largest difference ${String(measure.strayLargest)}`,
    });
  }
  for (const id of measure.empty) {
    failures.push({
      filmId,
      rule: 'empty-text-box',
      at: `${frame}, text ${JSON.stringify(id)}`,
      detail: 'no pixel differs inside its reported box between the text and hidden-text renders',
    });
  }
  return failures;
}

/**
 * Containment: on every probe frame, the look's own pixels (the post chain
 * skipped) differ between its text and hidden-text renders only inside the
 * boxes it reported, and inside every one of them, so text drawn on a frame
 * that reports no box fails; a frame that reports boxes yet on which nothing
 * differs is a look that ignores `hideText`. Stray pixels that are only the
 * GPU's small wrong block ({@link isSmallDifference}) pass, listed among the
 * measurements.
 */
export function containmentGate(filmId: string, frames: readonly FrameContainment[]): GateResult {
  const failures = frames.flatMap((measure) => containmentFailures(filmId, measure));
  const boxes = frames.reduce((sum, { boxes: count }) => sum + count, 0);
  const differing = frames.reduce((sum, { differing: count }) => sum + count, 0);
  const strays = frames.reduce((sum, { strays: count }) => sum + count, 0);
  const measured =
    frames.length === 0
      ? 'no probe frame checked'
      : `${plural(boxes, 'text box', 'text boxes')} on ${plural(frames.length, 'probe frame', 'probe frames')}; ${plural(differing, 'differing pixel', 'differing pixels')}, ${String(strays)} outside every box`;
  const small = frames.flatMap((measure) => smallStrays(measure) ?? []);
  return gateResult(
    'containment',
    failures,
    small.length === 0
      ? [measured]
      : [measured, `passed with a small difference outside every box: ${small.join(', ')}`]
  );
}
