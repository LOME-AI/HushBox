import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';

import { createStereo, sampleAt } from './buffer.js';
import { bandPower, nextAfter } from './dsp-test-support.js';
import { fdnReverb } from './reverb.js';

import type { StereoBuffer } from './buffer.js';

const NYQUIST = SAMPLE_RATE / 2;
/** The highest damping cutoff: the loop filters pass nearly everything. */
const UNDAMPED = nextAfter(NYQUIST, -1);

/** A stereo buffer holding one unit sample at the start of the left channel. */
function leftImpulse(samples: number): StereoBuffer {
  const buffer = createStereo(samples);
  buffer.left[0] = 1;
  return buffer;
}

/**
 * Seconds until the Schroeder energy-decay curve — the energy still to come,
 * summed over both channels — has fallen 60 dB below its value at the impulse.
 */
function decayTime(response: StereoBuffer): number {
  const remaining = new Float64Array(response.left.length + 1);
  for (let index = response.left.length - 1; index >= 0; index--) {
    const left = sampleAt(response.left, index);
    const right = sampleAt(response.right, index);
    remaining[index] = sampleAt(remaining, index + 1) + left * left + right * right;
  }
  const threshold = sampleAt(remaining, 0) * 1e-6;
  const index = remaining.findIndex((energy) => energy <= threshold);
  return index / SAMPLE_RATE;
}

describe('fdnReverb', () => {
  it.each([0.5, 1, 2])(
    'decays by 60 dB after at least rt60 × 0.8 and within rt60 × 1.2, for an rt60 of %s s',
    (rt60) => {
      const response = fdnReverb(leftImpulse(1.5 * rt60 * SAMPLE_RATE), {
        rt60,
        damping: UNDAMPED,
      });
      const seconds = decayTime(response);
      expect(seconds).toBeGreaterThanOrEqual(rt60 * 0.8);
      expect(seconds).toBeLessThanOrEqual(rt60 * 1.2);
    }
  );

  it('spreads an impulse in one channel into both, differently', () => {
    const response = fdnReverb(leftImpulse(SAMPLE_RATE), { rt60: 1, damping: UNDAMPED });
    const rightEnergy = response.right.reduce((sum, sample) => sum + sample * sample, 0);
    expect(rightEnergy).toBeGreaterThan(0);
    expect(response.right).not.toEqual(response.left);
  });

  it('decays faster above its damping cutoff than an undamped tail does', () => {
    const tailWindow = { from: SAMPLE_RATE / 2, length: 4800 };
    const high = { low: 8000, high: 16_000 };
    const damped = fdnReverb(leftImpulse(SAMPLE_RATE), { rt60: 2, damping: 2000 });
    const undamped = fdnReverb(leftImpulse(SAMPLE_RATE), { rt60: 2, damping: UNDAMPED });
    expect(bandPower(damped.left, high, tailWindow)).toBeLessThan(
      bandPower(undamped.left, high, tailWindow) / 1000
    );
  });

  it('returns buffers as long as its input', () => {
    const response = fdnReverb(createStereo(37), { rt60: 1, damping: UNDAMPED });
    expect([response.left.length, response.right.length]).toEqual([37, 37]);
  });

  it('refuses channels of different lengths', () => {
    const input = { left: new Float32Array(4), right: new Float32Array(3) };
    expect(() => fdnReverb(input, { rt60: 1, damping: UNDAMPED })).toThrow(
      'left and right hold 4 and 3 samples: a stereo buffer needs equal channels'
    );
  });

  it('accepts the smallest positive rt60', () => {
    expect(() =>
      fdnReverb(leftImpulse(8), { rt60: Number.MIN_VALUE, damping: UNDAMPED })
    ).not.toThrow();
  });

  it('refuses an rt60 of 0', () => {
    expect(() => fdnReverb(leftImpulse(8), { rt60: 0, damping: UNDAMPED })).toThrow(
      'rt60 must be in (0, Infinity), got 0'
    );
  });

  it('accepts the largest finite rt60', () => {
    expect(() =>
      fdnReverb(leftImpulse(8), { rt60: Number.MAX_VALUE, damping: UNDAMPED })
    ).not.toThrow();
  });

  it('refuses an infinite rt60', () => {
    expect(() =>
      fdnReverb(leftImpulse(8), { rt60: Number.POSITIVE_INFINITY, damping: UNDAMPED })
    ).toThrow(RangeError);
  });

  it('accepts a damping cutoff of 0 Hz', () => {
    expect(() => fdnReverb(leftImpulse(8), { rt60: 1, damping: 0 })).not.toThrow();
  });

  it('refuses the double just below 0 Hz', () => {
    expect(() => fdnReverb(leftImpulse(8), { rt60: 1, damping: -Number.MIN_VALUE })).toThrow(
      /damping must be in \[0, 24000\)/
    );
  });

  it('accepts the double just below the Nyquist frequency', () => {
    expect(() => fdnReverb(leftImpulse(8), { rt60: 1, damping: UNDAMPED })).not.toThrow();
  });

  it('refuses the Nyquist frequency', () => {
    expect(() => fdnReverb(leftImpulse(8), { rt60: 1, damping: NYQUIST })).toThrow(RangeError);
  });
});
