import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { OCTAVE_CENTERS_HZ, octaveBandBalance, octaveBandIndex } from './octave-bands.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

function tones(frequencies: readonly number[], seconds: number): StereoBuffer {
  const channel = Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, index) => {
    let sum = 0;
    for (const frequency of frequencies) {
      sum += 0.25 * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
    }
    return sum;
  });
  return { left: channel, right: Float32Array.from(channel) };
}

/** The next double below a positive finite value. */
function nextDown(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

function levelAt(
  bands: readonly { centerHz: number; levelDb: number }[],
  centerHz: number
): number {
  return bands.find((band) => band.centerHz === centerHz)?.levelDb ?? Number.NaN;
}

describe('OCTAVE_CENTERS_HZ', () => {
  it('holds the ten octaves from 31.25 Hz to 16 kHz on the base-two 1 kHz series', () => {
    expect(OCTAVE_CENTERS_HZ).toEqual([31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16_000]);
  });
});

describe('octaveBandIndex', () => {
  it('puts a frequency exactly on a lower edge in the band above it', () => {
    expect(octaveBandIndex(1000 / Math.SQRT2)).toBe(5);
  });

  it('puts the frequency just below a lower edge in the band below it', () => {
    expect(octaveBandIndex(nextDown(1000 / Math.SQRT2))).toBe(4);
  });

  it('puts the lowest edge in the lowest band', () => {
    expect(octaveBandIndex(31.25 / Math.SQRT2)).toBe(0);
  });

  it('puts the frequency just below the lowest edge in no band', () => {
    expect(octaveBandIndex(nextDown(31.25 / Math.SQRT2))).toBe(-1);
  });

  it('puts the frequency just below the highest edge in the highest band', () => {
    expect(octaveBandIndex(nextDown(32_000 / Math.SQRT2))).toBe(9);
  });

  it('puts the highest edge in no band', () => {
    expect(octaveBandIndex(32_000 / Math.SQRT2)).toBe(-1);
  });
});

describe('octaveBandBalance', () => {
  it('puts a 1 kHz tone entirely in the 1 kHz octave', () => {
    const bands = octaveBandBalance(tones([1000], 1));
    expect(levelAt(bands, 1000)).toBeGreaterThan(-0.01);
    for (const band of bands.filter(({ centerHz }) => centerHz !== 1000)) {
      expect(band.levelDb).toBeLessThan(-40);
    }
  });

  it('splits two equal tones evenly between their octaves', () => {
    const bands = octaveBandBalance(tones([100, 4000], 1));
    expect(levelAt(bands, 125)).toBeCloseTo(-3.01, 1);
    expect(levelAt(bands, 4000)).toBeCloseTo(-3.01, 1);
  });

  it('lists one band per octave centre in order', () => {
    const bands = octaveBandBalance(tones([1000], 0.1));
    expect(bands.map(({ centerHz }) => centerHz)).toEqual(OCTAVE_CENTERS_HZ);
  });

  it('reads every band of digital silence as −Infinity', () => {
    const bands = octaveBandBalance({ left: new Float32Array(100), right: new Float32Array(100) });
    expect(bands.every(({ levelDb }) => levelDb === Number.NEGATIVE_INFINITY)).toBe(true);
  });
});
