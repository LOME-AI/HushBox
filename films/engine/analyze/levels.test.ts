import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { clipCount, dcOffset, samplePeakDbfs } from './levels.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Samples in one cycle of a 1 kHz wave. */
const TONE_PERIOD = SAMPLE_RATE / 1000;

/** The largest single-precision value below 1. */
const JUST_BELOW_FULL_SCALE = 1 - 2 ** -24;

function stereo(left: readonly number[], right: readonly number[] = left): StereoBuffer {
  return { left: Float32Array.from(left), right: Float32Array.from(right) };
}

describe('samplePeakDbfs', () => {
  it('reads the largest sample magnitude across both channels', () => {
    expect(samplePeakDbfs(stereo([0.25, -0.1], [0.1, -0.5]))).toBeCloseTo(-6.0206, 4);
  });

  it('reads digital silence as −Infinity', () => {
    expect(samplePeakDbfs(stereo([0, 0]))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('clipCount', () => {
  it('counts every sample of a full-scale square wave as clipped', () => {
    const square = Array.from({ length: 10 * TONE_PERIOD }, (_, index) =>
      Math.floor(index / (TONE_PERIOD / 2)) % 2 === 0 ? 1 : -1
    );
    expect(clipCount(stereo(square))).toBe(2 * square.length);
  });

  it('counts a sample at positive full scale', () => {
    expect(clipCount(stereo([1], [0]))).toBe(1);
  });

  it('does not count the largest sample below positive full scale', () => {
    expect(clipCount(stereo([JUST_BELOW_FULL_SCALE], [0]))).toBe(0);
  });

  it('counts a sample at negative full scale', () => {
    expect(clipCount(stereo([0], [-1]))).toBe(1);
  });

  it('does not count the largest sample magnitude below negative full scale', () => {
    expect(clipCount(stereo([0], [-JUST_BELOW_FULL_SCALE]))).toBe(0);
  });
});

describe('dcOffset', () => {
  it('reads each channel mean', () => {
    expect(dcOffset(stereo([0.25, 0.25, 0.25, 0.25], [-0.5, -0.5, 0, 0]))).toEqual({
      left: 0.25,
      right: -0.25,
    });
  });

  it('reads a whole number of sine periods as near zero', () => {
    const sine = Array.from({ length: 10 * TONE_PERIOD }, (_, index) =>
      Math.sin((2 * Math.PI * index) / TONE_PERIOD)
    );
    const { left, right } = dcOffset(stereo(sine));
    expect(Math.max(Math.abs(left), Math.abs(right))).toBeLessThan(1e-7);
  });

  it('refuses an empty signal', () => {
    expect(() => dcOffset(stereo([]))).toThrow(/empty/);
  });
});
