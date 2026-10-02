import { at } from './at.js';
import { COLOR_CHANNELS } from './raster.js';

import type { Raster } from './raster.js';

/**
 * The most pixels a frame comparison may find differing and still pass. Sized
 * to the GPU's occasional small wrong block (an 8×4 block, a 6×6 blob), not to
 * its rare large events such as a 104×104 black square, which still fail.
 */
export const SMALL_DIFFERENCE_PIXELS = 64;
/** The largest change, on any colour channel, a passing small difference may hold. */
export const SMALL_DIFFERENCE_LEVELS = 8;

/** How two renders of one frame differ: the pixels that differ and the largest change on any colour channel. */
export interface PixelDifference {
  pixels: number;
  largest: number;
}

/** The largest change on any colour channel at one pixel of two same-size rasters, alpha ignored. */
export function largestChange(a: Raster, b: Raster, pixel: number): number {
  let largest = 0;
  for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
    const change = Math.abs(
      at(a.data, pixel * a.channels + channel) - at(b.data, pixel * b.channels + channel)
    );
    largest = Math.max(largest, change);
  }
  return largest;
}

/**
 * Whether a frame comparison passes despite its difference: at most
 * {@link SMALL_DIFFERENCE_PIXELS} pixels differ and none by more than
 * {@link SMALL_DIFFERENCE_LEVELS} levels. Purity and containment both judge by it.
 */
export function isSmallDifference({ pixels, largest }: PixelDifference): boolean {
  return pixels <= SMALL_DIFFERENCE_PIXELS && largest <= SMALL_DIFFERENCE_LEVELS;
}

/** A frame passed with a small difference, as a gate's measured line lists it. */
export function smallDifferenceNote(frame: number, { pixels, largest }: PixelDifference): string {
  const noun = pixels === 1 ? 'pixel' : 'pixels';
  return `frame ${String(frame)} (${String(pixels)} ${noun}, largest ${String(largest)})`;
}
