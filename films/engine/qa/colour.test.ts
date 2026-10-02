import { describe, expect, it } from 'vitest';

import { blockMeans, colourCheck, colourScore, colourScoreOfMeans } from './colour.js';

import type { Raster } from './raster.js';

function raster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number]
): Raster {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 3);
    }
  }
  return { width, height, channels: 3, data };
}

const GREY = raster(32, 32, () => [100, 100, 100]);

describe('blockMeans', () => {
  it('averages each channel over each 16×16 block', () => {
    const halves = raster(32, 16, (x) => (x < 16 ? [0, 10, 20] : [30, 40, 50]));

    expect([...blockMeans(halves)]).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('averages a partial edge block over the pixels it holds', () => {
    const wide = raster(20, 16, (x) => (x < 16 ? [0, 0, 0] : [8, 8, 8]));

    expect([...blockMeans(wide)]).toEqual([0, 0, 0, 8, 8, 8]);
  });
});

describe('colourCheck', () => {
  it('passes a decoded frame whose block means match the still', () => {
    expect(
      colourCheck('film', [colourScore({ frame: 4, decoded: GREY, still: GREY })]).failures
    ).toEqual([]);
  });

  it('passes block means 45.9 dB from the still, above the 44 dB floor', () => {
    const shifted = raster(32, 32, () => [102, 101, 100]);

    expect(
      colourCheck('film', [colourScore({ frame: 4, decoded: shifted, still: GREY })]).failures
    ).toEqual([]);
  });

  it('fails block means 43.9 dB from the still, naming the film, the rule and the frame', () => {
    const shifted = raster(32, 32, () => [102, 102, 100]);

    expect(
      colourCheck('film', [colourScore({ frame: 4, decoded: shifted, still: GREY })]).failures
    ).toEqual([
      {
        filmId: 'film',
        rule: 'colour',
        at: 'frame 4',
        detail:
          'the 16×16 block means of the MP4, decoded as tagged, reach 43.9 dB PSNR against the still, below 44 dB',
      },
    ]);
  });

  it('reports the lowest block-mean PSNR', () => {
    const shifted = raster(32, 32, () => [102, 100, 100]);

    expect(
      colourCheck('film', [colourScore({ frame: 4, decoded: shifted, still: GREY })]).measured
    ).toEqual(['lowest 16×16 block-mean PSNR 46.9 dB at frame 4 (floor 44 dB)']);
  });

  it('refuses a decoded frame whose size differs from the still', () => {
    const small = raster(16, 16, () => [0, 0, 0]);

    expect(() => colourScore({ frame: 4, decoded: small, still: GREY })).toThrow(/16×16 and 32×32/);
  });
});

/** Grey 100 in four 16×16 blocks, each block's channels raised by the given steps, in block then channel order. */
function stepped(steps: readonly number[]): Raster {
  return raster(32, 32, (x, y) => {
    const block = (y < 16 ? 0 : 2) + (x < 16 ? 0 : 1);
    const level = (channel: number): number => 100 + (steps[block * 3 + channel] ?? 0);
    return [level(0), level(1), level(2)];
  });
}

describe('colourCheck: the 44 dB floor', () => {
  it('accepts block means at 44.007 dB', () => {
    // Squared steps summing to 31 over 12 block-channel means: an MSE of 2.583; the floor is 2.5875.
    const score = colourScore({ frame: 4, decoded: stepped([5, 2, 1, 1]), still: GREY });

    expect(colourCheck('film', [score]).failures).toEqual([]);
  });

  it('refuses block means at 43.87 dB', () => {
    const score = colourScore({ frame: 4, decoded: stepped([5, 2, 1, 1, 1]), still: GREY });

    expect(colourCheck('film', [score]).failures).toHaveLength(1);
  });
});

describe('colourCheck: a score that is not a number', () => {
  it('refuses it', () => {
    expect(colourCheck('film', [{ frame: 4, psnr: Number.NaN }]).failures).toHaveLength(1);
  });

  it('accepts identical block means, whose PSNR is infinite', () => {
    expect(colourCheck('film', [{ frame: 4, psnr: Number.POSITIVE_INFINITY }]).failures).toEqual(
      []
    );
  });
});

describe('colourScoreOfMeans', () => {
  it('scores block means taken ahead of time as colourScore scores the rasters', () => {
    const shifted = raster(32, 32, () => [102, 100, 100]);

    expect(colourScoreOfMeans(4, blockMeans(shifted), blockMeans(GREY))).toEqual(
      colourScore({ frame: 4, decoded: shifted, still: GREY })
    );
  });

  it('refuses block means of different sizes', () => {
    expect(() => colourScoreOfMeans(4, new Float64Array(3), new Float64Array(6))).toThrow(
      /3 and 6/
    );
  });
});
