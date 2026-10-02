import { describe, expect, it } from 'vitest';

import { HEIGHT, WIDTH } from '../time/grid.js';
import { sameBytes } from './bytes.js';
import { BLOCK, blockMeans, colourScoreOfMeans } from './colour.js';
import { chartColourCheck, colourChart } from './colour-chart.js';

const CHART = colourChart();

function pixel(x: number, y: number): [number, number, number] {
  const { data } = CHART;
  const offset = (y * WIDTH + x) * 3;
  return [data[offset] ?? -1, data[offset + 1] ?? -1, data[offset + 2] ?? -1];
}

function colours(): Set<string> {
  const { data } = CHART;
  const found = new Set<string>();
  for (let offset = 0; offset < data.length; offset += 3) {
    found.add(`${String(data[offset])},${String(data[offset + 1])},${String(data[offset + 2])}`);
  }
  return found;
}

/** Y′CbCr coefficients of a matrix: the red and blue weights of its luma. */
const MATRICES = { bt601: [0.299, 0.114], bt709: [0.2126, 0.0722] } as const;

/** An 8-bit RGB colour to limited-range Y′CbCr by one matrix, and back by another, unrounded. */
function across(
  [red, green, blue]: ArrayLike<number> & Iterable<number>,
  encode: keyof typeof MATRICES,
  decode: keyof typeof MATRICES
): number[] {
  const [kr, kb] = MATRICES[encode];
  const r = (red ?? 0) / 255;
  const g = (green ?? 0) / 255;
  const b = (blue ?? 0) / 255;
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  const chromaBlue = (b - y) / (2 * (1 - kb));
  const chromaRed = (r - y) / (2 * (1 - kr));
  const [dr, db] = MATRICES[decode];
  const outR = y + 2 * (1 - dr) * chromaRed;
  const outB = y + 2 * (1 - db) * chromaBlue;
  const outG = (y - dr * outR - db * outB) / (1 - dr - db);
  return [outR, outG, outB].map((value) => Math.min(255, Math.max(0, value * 255)));
}

/** The chart's block means as a delivery encoded by one matrix and decoded by another would give them. */
function meansAcross(encode: keyof typeof MATRICES, decode: keyof typeof MATRICES): Float64Array {
  const means = blockMeans(CHART);
  const out = new Float64Array(means.length);
  for (let index = 0; index < means.length; index += 3) {
    out.set(across(means.subarray(index, index + 3), encode, decode), index);
  }
  return out;
}

describe('colourChart', () => {
  it('fills a whole frame of RGB', () => {
    const chart = CHART;

    expect([chart.width, chart.height, chart.channels, chart.data.length]).toEqual([
      WIDTH,
      HEIGHT,
      3,
      WIDTH * HEIGHT * 3,
    ]);
  });

  it('gives each 16×16 block one colour', () => {
    const mixed: string[] = [];
    for (let top = 0; top < HEIGHT; top += BLOCK) {
      for (let left = 0; left < WIDTH; left += BLOCK) {
        const first = pixel(left, top).join(',');
        const right = Math.min(left + BLOCK, WIDTH) - 1;
        const bottom = Math.min(top + BLOCK, HEIGHT) - 1;
        if (pixel(right, bottom).join(',') !== first || pixel(right, top).join(',') !== first) {
          mixed.push(`${String(left)},${String(top)}`);
        }
      }
    }

    expect(mixed).toEqual([]);
  });

  it('holds only fully saturated colours: one channel at zero, one lit', () => {
    const unsaturated = [...colours()].filter((colour) => {
      const channels = colour.split(',').map(Number);
      return Math.min(...channels) !== 0 || Math.max(...channels) === 0;
    });

    expect(unsaturated).toEqual([]);
  });

  it('holds the six primary and secondary hues at eight levels', () => {
    expect(colours().size).toBe(48);
  });

  it('draws the same pixels on every call', () => {
    expect(sameBytes(colourChart().data, CHART.data)).toBe(true);
  });

  it('comes back exact from a BT.709 encode decoded as BT.709', () => {
    const means = blockMeans(CHART);

    expect(colourScoreOfMeans(0, meansAcross('bt709', 'bt709'), means).psnr).toBeGreaterThan(90);
  });

  it('falls below the colour floor from a BT.601 encode decoded as BT.709', () => {
    const score = colourScoreOfMeans(0, meansAcross('bt601', 'bt709'), blockMeans(CHART));

    expect(chartColourCheck('film', score.psnr).failures).toHaveLength(1);
  });
});

describe('chartColourCheck', () => {
  it('passes a chart at the colour floor', () => {
    expect(chartColourCheck('film', 44).failures).toEqual([]);
  });

  it('fails a chart below the colour floor, naming the matrix', () => {
    expect(chartColourCheck('film', 27.24).failures).toEqual([
      {
        filmId: 'film',
        rule: 'colour-matrix',
        at: 'colour chart',
        detail:
          'the saturated colour chart, encoded as delivered and decoded as tagged, reaches 27.2 dB block-mean PSNR against itself, below 44 dB: the delivery converts RGB to Y′CbCr by a matrix other than the BT.709 its tags declare',
      },
    ]);
  });

  it('fails a score that is not a number', () => {
    expect(chartColourCheck('film', Number.NaN).failures).toHaveLength(1);
  });

  it('reports the chart score and the floor', () => {
    expect(chartColourCheck('film', 50.41).measured).toEqual([
      'colour chart block-mean PSNR 50.4 dB through the delivery encode and the decode as tagged (floor 44 dB)',
    ]);
  });
});
