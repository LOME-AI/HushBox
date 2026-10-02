import { HEIGHT, WIDTH } from '../time/grid.js';

import { at } from './at.js';
import { BLOCK, FLOOR_DB } from './colour.js';

import type { GateFailure } from './gate.js';
import type { Raster } from './raster.js';

/** Red, yellow, green, cyan, blue and magenta, as the channels each lights. */
const HUES = [
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
  [1, 0, 1],
] as const;
const LEVELS = [255, 224, 192, 160, 128, 96, 64, 40] as const;

/**
 * Where patch `index` of `count` starts along a side of `length` pixels, on an
 * edge of the colour check's blocks, so each block, and each 2×2 chroma site,
 * holds one colour.
 */
function patchEdge(index: number, count: number, length: number): number {
  return Math.min(length, Math.round((index * length) / count / BLOCK) * BLOCK);
}

function patchOf(position: number, count: number, length: number): number {
  let patch = 0;
  while (position >= patchEdge(patch + 1, count, length)) {
    patch += 1;
  }
  return patch;
}

/**
 * A whole frame of fully saturated patches: the six primary and secondary hues
 * in columns, each at eight levels in rows. Greys are nearly the same under any
 * Y′CbCr matrix, so a film of dark, near-grey frames cannot show a wrong matrix;
 * these colours move far under one.
 */
export function colourChart(): Raster {
  const data = new Uint8Array(WIDTH * HEIGHT * 3);
  const channels = HUES.flat();
  const columns = Array.from({ length: WIDTH }, (_, x) => patchOf(x, HUES.length, WIDTH));
  for (let y = 0; y < HEIGHT; y++) {
    const level = at(LEVELS, patchOf(y, LEVELS.length, HEIGHT));
    for (let x = 0; x < WIDTH; x++) {
      const hue = at(columns, x);
      for (let channel = 0; channel < 3; channel++) {
        data[(y * WIDTH + x) * 3 + channel] = at(channels, hue * 3 + channel) * level;
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, channels: 3, data };
}

/**
 * The delivery's matrix: the colour chart, encoded as the film is delivered and
 * decoded as its tags say, reaches the colour check's floor in block-mean PSNR
 * against itself, whatever colours the film's own frames hold.
 */
export function chartColourCheck(
  filmId: string,
  psnr: number
): { failures: GateFailure[]; measured: string[] } {
  const reached = `${psnr.toFixed(1)} dB`;
  const floor = `${String(FLOOR_DB)} dB`;
  const failures: GateFailure[] =
    Number.isNaN(psnr) || psnr < FLOOR_DB
      ? [
          {
            filmId,
            rule: 'colour-matrix',
            at: 'colour chart',
            detail: `the saturated colour chart, encoded as delivered and decoded as tagged, reaches ${reached} block-mean PSNR against itself, below ${floor}: the delivery converts RGB to Y′CbCr by a matrix other than the BT.709 its tags declare`,
          },
        ]
      : [];
  return {
    failures,
    measured: [
      `colour chart block-mean PSNR ${reached} through the delivery encode and the decode as tagged (floor ${floor})`,
    ],
  };
}
