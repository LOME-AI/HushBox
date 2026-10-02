import { at } from './at.js';
import { lowestBy } from './pick.js';
import { COLOR_CHANNELS, requireRaster } from './raster.js';

import type { GateFailure } from './gate.js';
import type { Raster } from './raster.js';

/** The side of the square blocks whose mean colours are compared. */
export const BLOCK = 16;
/** The PSNR, in dB, the block means of the delivered frame must reach against the still. */
export const FLOOR_DB = 44;

/** A probe frame decoded from the MP4 as its tags say, and its still. */
export interface ColourFrame {
  frame: number;
  decoded: Raster;
  still: Raster;
}

/** Each 16×16 block's mean of each colour channel, blocks row by row; an edge block averages the pixels it holds. */
export function blockMeans(raster: Raster): Float64Array {
  requireRaster(raster);
  const { width, height, channels, data } = raster;
  const columns = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  const sums = new Float64Array(columns * rows * COLOR_CHANNELS);
  const counts = new Float64Array(columns * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = Math.floor(y / BLOCK) * columns + Math.floor(x / BLOCK);
      counts[block] = at(counts, block) + 1;
      for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
        const index = block * COLOR_CHANNELS + channel;
        sums[index] = at(sums, index) + at(data, (y * width + x) * channels + channel);
      }
    }
  }
  return sums.map((sum, index) => sum / at(counts, Math.floor(index / COLOR_CHANNELS)));
}

/** A probe frame's block-mean PSNR, so its rasters can be dropped before the next is decoded. */
export interface ColourScore {
  frame: number;
  psnr: number;
}

/** The PSNR between two frames' block means, taken ahead of time so the frames need not be held together. */
export function colourScoreOfMeans(
  frame: number,
  decoded: Float64Array,
  still: Float64Array
): ColourScore {
  if (decoded.length !== still.length) {
    throw new RangeError(
      `block means of ${String(decoded.length)} and ${String(still.length)} values cannot be compared`
    );
  }
  let squares = 0;
  for (const [index, value] of decoded.entries()) {
    const difference = value - at(still, index);
    squares += difference * difference;
  }
  return { frame, psnr: 10 * Math.log10((255 * 255) / (squares / decoded.length)) };
}

/** The block-mean PSNR of one probe frame's delivered decode against its still. */
export function colourScore({ frame, decoded, still }: ColourFrame): ColourScore {
  if (decoded.width !== still.width || decoded.height !== still.height) {
    throw new RangeError(
      `a decoded frame of ${String(decoded.width)}×${String(decoded.height)} and ${String(still.width)}×${String(still.height)} still cannot be compared`
    );
  }
  return colourScoreOfMeans(frame, blockMeans(decoded), blockMeans(still));
}

/**
 * The delivery's colour: at each probe frame, the 16×16 block means of the MP4
 * decoded as its tags say reach 44 dB PSNR against the still. Block means pass
 * over encode noise and chroma subsampling but not a wrong matrix or range,
 * which the luma comparison cannot see because its references share the
 * delivery's own conversion.
 */
export function colourCheck(
  filmId: string,
  scored: readonly ColourScore[]
): { failures: GateFailure[]; measured: string[] } {
  const failures = scored
    .filter(({ psnr }) => Number.isNaN(psnr) || psnr < FLOOR_DB)
    .map(
      ({ frame, psnr }): GateFailure => ({
        filmId,
        rule: 'colour',
        at: `frame ${String(frame)}`,
        detail: `the ${String(BLOCK)}×${String(BLOCK)} block means of the MP4, decoded as tagged, reach ${psnr.toFixed(1)} dB PSNR against the still, below ${String(FLOOR_DB)} dB`,
      })
    );
  const lowest = lowestBy(scored, ({ psnr }) => psnr);
  const measured =
    lowest === null
      ? []
      : [
          `lowest ${String(BLOCK)}×${String(BLOCK)} block-mean PSNR ${lowest.psnr.toFixed(1)} dB at frame ${String(lowest.frame)} (floor ${String(FLOOR_DB)} dB)`,
        ];
  return { failures, measured };
}
