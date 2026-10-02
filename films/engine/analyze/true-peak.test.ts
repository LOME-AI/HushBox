import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { samplePeakDbfs } from './levels.js';
import { truePeakDbtp } from './true-peak.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Raised-cosine gain over the first and last `fade` samples of a `length`-sample signal. */
function edgeFade(index: number, length: number, fade: number): number {
  const edge = Math.min(index, length - 1 - index);
  return edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade);
}

/**
 * A full-scale 12 kHz sine at 45° phase for one second: every sample sits at
 * ±0.7071 (−3.01 dBFS) while the waveform between them reaches ±1. A 10 ms fade
 * at each end keeps the cut edges from adding overshoot of their own.
 */
function sine12kAt45Degrees(): StereoBuffer {
  const period = SAMPLE_RATE / 12_000;
  const channel = Float32Array.from({ length: SAMPLE_RATE }, (_, index) => {
    const sample = Math.sin((2 * Math.PI * (index % period)) / period + Math.PI / 4);
    return sample * edgeFade(index, SAMPLE_RATE, SAMPLE_RATE / 100);
  });
  return { left: channel, right: Float32Array.from(channel) };
}

describe('truePeakDbtp', () => {
  it('reads the 12 kHz 45° sine whose samples peak at −3.01 dBFS as 0.0 dBTP', () => {
    const signal = sine12kAt45Degrees();
    expect(samplePeakDbfs(signal)).toBeCloseTo(-3.01, 2);
    expect(Math.abs(truePeakDbtp(signal))).toBeLessThanOrEqual(0.1);
  });

  it('reads an isolated sample at its own level', () => {
    const left = new Float32Array(64);
    left[32] = 0.5;
    expect(truePeakDbtp({ left, right: new Float32Array(64) })).toBeCloseTo(-6.0206, 4);
  });

  it('reads the louder of the two channels', () => {
    const right = new Float32Array(64);
    right[10] = -0.25;
    expect(truePeakDbtp({ left: new Float32Array(64), right })).toBeCloseTo(-12.0412, 4);
  });

  it('reads digital silence as −Infinity', () => {
    expect(truePeakDbtp({ left: new Float32Array(8), right: new Float32Array(8) })).toBe(
      Number.NEGATIVE_INFINITY
    );
  });

  it('refuses channels of unequal length', () => {
    expect(() => truePeakDbtp({ left: new Float32Array(2), right: new Float32Array(3) })).toThrow(
      RangeError
    );
  });
});
