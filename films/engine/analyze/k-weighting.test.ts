import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { K_HIGH_PASS, K_SHELF, kWeightStereo } from './k-weighting.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** A stereo sine of `frequency` Hz at amplitude 1 for `seconds` seconds at the film sample rate. */
function sine(frequency: number, seconds: number): StereoBuffer {
  const channel = Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, index) =>
    Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE)
  );
  return { left: channel, right: Float32Array.from(channel) };
}

/** RMS of the second half of a signal, past the filter's settling. */
function settledRms(channel: Float64Array | Float32Array): number {
  const half = channel.subarray(channel.length / 2);
  let sum = 0;
  for (const sample of half) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / half.length);
}

describe('K-weighting coefficients at 48 kHz', () => {
  // ITU-R BS.1770-4, Annex 1, Tables 1 and 2.
  it('derives the pre-filter (high shelf) of Table 1', () => {
    expect(K_SHELF.b0).toBeCloseTo(1.535_124_859_586_97, 13);
    expect(K_SHELF.b1).toBeCloseTo(-2.691_696_189_406_38, 13);
    expect(K_SHELF.b2).toBeCloseTo(1.198_392_810_852_85, 13);
    expect(K_SHELF.a1).toBeCloseTo(-1.690_659_293_182_41, 13);
    expect(K_SHELF.a2).toBeCloseTo(0.732_480_774_215_85, 13);
  });

  it('derives the RLB high-pass of Table 2', () => {
    expect([K_HIGH_PASS.b0, K_HIGH_PASS.b1, K_HIGH_PASS.b2]).toEqual([1, -2, 1]);
    expect(K_HIGH_PASS.a1).toBeCloseTo(-1.990_047_454_833_98, 13);
    expect(K_HIGH_PASS.a2).toBeCloseTo(0.990_072_250_366_21, 13);
  });
});

describe('kWeightStereo', () => {
  it('raises a 1 kHz tone by 0.70 dB', () => {
    const weighted = kWeightStereo(sine(1000, 1));
    const gainDb = 20 * Math.log10(settledRms(weighted.left) / Math.SQRT1_2);
    expect(gainDb).toBeCloseTo(0.698, 2);
  });

  it('cuts a 20 Hz tone by more than 10 dB', () => {
    const weighted = kWeightStereo(sine(20, 2));
    const gainDb = 20 * Math.log10(settledRms(weighted.right) / Math.SQRT1_2);
    expect(gainDb).toBeLessThan(-10);
  });

  it('weights each channel separately', () => {
    const signal: StereoBuffer = { left: sine(1000, 1).left, right: new Float32Array(SAMPLE_RATE) };
    const weighted = kWeightStereo(signal);
    expect(settledRms(weighted.right)).toBe(0);
  });
});
