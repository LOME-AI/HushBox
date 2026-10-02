import { at } from './at.js';
import { sameBytes } from './bytes.js';
import { gateResult } from './gate.js';
import { COLOR_CHANNELS, requireRaster } from './raster.js';
import {
  SMALL_DIFFERENCE_LEVELS,
  SMALL_DIFFERENCE_PIXELS,
  isSmallDifference,
  largestChange,
  smallDifferenceNote,
} from './small-difference.js';

import type { GateFailure, GateResult } from './gate.js';
import type { Raster } from './raster.js';
import type { PixelDifference } from './small-difference.js';

/**
 * A rendered frame as its PNG bytes and the pixels they decode to. The pixels
 * are read only where the bytes differ, so a caller may leave them undecoded
 * (null) until then.
 */
export interface EncodedFrame {
  bytes: Uint8Array;
  raster: Raster | null;
}

/** One probe frame from the one-tab master and from a fresh-page still. */
export interface PurityFrame {
  frame: number;
  master: EncodedFrame;
  still: EncodedFrame;
}

interface Difference extends PixelDifference {
  squares: number;
  firstRow: number;
  lastRow: number;
}

/** Adds one pixel's colour-channel differences to the running tally. */
function tally(difference: Difference, master: Raster, still: Raster, pixel: number): void {
  const change = largestChange(master, still, pixel);
  if (change === 0) {
    return;
  }
  for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
    const value =
      at(master.data, pixel * master.channels + channel) -
      at(still.data, pixel * still.channels + channel);
    difference.squares += value * value;
  }
  const row = Math.floor(pixel / master.width);
  difference.pixels += 1;
  difference.largest = Math.max(difference.largest, change);
  difference.firstRow = difference.firstRow === -1 ? row : difference.firstRow;
  difference.lastRow = row;
}

/** How two same-size rasters differ over their colour channels. */
function pixelDifference(master: Raster, still: Raster): Difference {
  const difference: Difference = { pixels: 0, largest: 0, squares: 0, firstRow: -1, lastRow: -1 };
  const pixels = master.width * master.height;
  for (let pixel = 0; pixel < pixels; pixel++) {
    tally(difference, master, still, pixel);
  }
  return difference;
}

function describeDifference(
  { pixels, largest, squares, firstRow, lastRow }: Difference,
  { width, height }: Raster
): string {
  const psnr = 10 * Math.log10((255 * 255) / (squares / (width * height * COLOR_CHANNELS)));
  const noun = pixels === 1 ? 'pixel' : 'pixels';
  return `the one-tab master and a fresh-page still differ in ${String(pixels)} ${noun} (largest ${String(largest)}, rows ${String(firstRow)}–${String(lastRow)}); PSNR ${psnr.toFixed(1)} dB`;
}

/** One frame's verdict: a failure, a small difference it passed, or neither. */
interface Verdict {
  failure: GateFailure | null;
  small: string | null;
}

const PASSED: Verdict = { failure: null, small: null };

function purityVerdict(filmId: string, { frame, master, still }: PurityFrame): Verdict {
  if (sameBytes(master.bytes, still.bytes)) {
    return PASSED;
  }
  const at = `frame ${String(frame)}`;
  const fail = (detail: string): Verdict => ({
    failure: { filmId, rule: 'purity', at, detail },
    small: null,
  });
  const { raster: a } = master;
  const { raster: b } = still;
  if (a === null || b === null) {
    throw new RangeError(
      `purity: frame ${String(frame)} differs in its bytes, and its pixels were not decoded to describe how`
    );
  }
  if (a.width !== b.width || a.height !== b.height) {
    return fail(
      `the one-tab master is ${String(a.width)}×${String(a.height)} and the fresh-page still ${String(b.width)}×${String(b.height)}`
    );
  }
  requireRaster(a);
  requireRaster(b);
  const difference = pixelDifference(a, b);
  if (difference.pixels === 0) {
    return fail('the PNG bytes differ while every pixel matches');
  }
  if (isSmallDifference(difference)) {
    return { failure: null, small: smallDifferenceNote(frame, difference) };
  }
  return fail(describeDifference(difference, a));
}

/**
 * Purity: at every probe frame, the PNG of the one-tab master, which carries the
 * history of every frame before it, matches a fresh-page still, which carries
 * none. A frame that reads state left by earlier frames differs, and a
 * difference names its size and rows. The one allowance is the GPU's small wrong
 * block ({@link isSmallDifference}), passed and listed among the measurements.
 */
export function purityGate(filmId: string, frames: readonly PurityFrame[]): GateResult {
  if (frames.length === 0) {
    throw new RangeError(`${filmId}: purity: no probe frame was given to compare`);
  }
  const verdicts = frames.map((frame) => purityVerdict(filmId, frame));
  const failures = verdicts.flatMap(({ failure }) => failure ?? []);
  const small = verdicts.flatMap(({ small: note }) => note ?? []);
  const noun = frames.length === 1 ? 'probe frame' : 'probe frames';
  const compared = `${String(frames.length)} ${noun} compared: the one-tab master against a fresh-page still, allowing at most ${String(SMALL_DIFFERENCE_PIXELS)} differing pixels within ${String(SMALL_DIFFERENCE_LEVELS)} levels`;
  return gateResult(
    'purity',
    failures,
    small.length === 0
      ? [compared]
      : [compared, `passed with a small difference: ${small.join(', ')}`]
  );
}
