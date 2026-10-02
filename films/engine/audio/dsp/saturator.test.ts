import { describe, expect, it } from 'vitest';

import { tanh } from '../../dmath/dmath.js';

import { sampleAt } from './buffer.js';
import { decibels, goertzelPower } from './dsp-test-support.js';
import { sine } from './oscillators.js';
import { saturate } from './saturator.js';

import type { Window } from './dsp-test-support.js';

/** 0.1 s: a whole number of cycles of every multiple of 1 kHz. */
const WINDOW: Window = { from: 4800, length: 4800 };

function scaled(signal: Float32Array, gain: number): Float32Array {
  return signal.map((sample) => sample * gain);
}

/** The largest difference between two signals away from their first and last 200 samples. */
function largestDifference(a: Float32Array, b: Float32Array): number {
  let largest = 0;
  for (let index = 200; index < a.length - 200; index++) {
    largest = Math.max(largest, Math.abs(sampleAt(a, index) - sampleAt(b, index)));
  }
  return largest;
}

/**
 * Power below 20 kHz at multiples of 1 kHz, split into the 7 kHz tone's own
 * harmonics and the rest. Every harmonic of 7 kHz that folds back from above
 * Nyquist lands on a multiple of 1 kHz, so the rest is aliasing.
 */
function splitAt7k(signal: Float32Array): { harmonic: number; alias: number } {
  let harmonic = 0;
  let alias = 0;
  for (let frequency = 1000; frequency <= 20_000; frequency += 1000) {
    const power = goertzelPower(signal, frequency, WINDOW);
    if (frequency % 7000 === 0) {
      harmonic += power;
    } else {
      alias += power;
    }
  }
  return { harmonic, alias };
}

describe('saturate', () => {
  const quiet = scaled(sine({ frequency: 1000, samples: 4800 }), 0.001);

  it('passes a quiet signal unchanged and on the same samples at a drive of 1', () => {
    expect(largestDifference(saturate(quiet, 1), quiet)).toBeLessThan(1e-6);
  });

  it('scales a quiet signal by its drive', () => {
    expect(largestDifference(saturate(quiet, 4), scaled(quiet, 4))).toBeLessThan(4e-6);
  });

  it('holds a loud signal near full scale', () => {
    const loud = saturate(sine({ frequency: 1000, samples: 4800 }), 10);
    const peak = Math.max(...loud.map((sample) => Math.abs(sample)));
    expect(peak).toBeGreaterThan(0.95);
    expect(peak).toBeLessThan(1.25);
  });

  it('holds aliasing below 20 kHz at least 25 dB under a tanh applied at the base rate', () => {
    const tone = sine({ frequency: 7000, samples: 9600 });
    const oversampled = splitAt7k(saturate(tone, 8));
    const direct = splitAt7k(tone.map((sample) => tanh(8 * sample)));
    const ratio = direct.alias / direct.harmonic / (oversampled.alias / oversampled.harmonic);
    expect(decibels(ratio)).toBeGreaterThanOrEqual(25);
  });

  it('returns a buffer as long as its input', () => {
    expect(saturate(new Float32Array(37), 2)).toHaveLength(37);
  });

  it('accepts an empty input', () => {
    expect(saturate(new Float32Array(0), 2)).toHaveLength(0);
  });

  it('accepts the smallest positive drive', () => {
    expect(() => saturate(quiet, Number.MIN_VALUE)).not.toThrow();
  });

  it('refuses a drive of 0', () => {
    expect(() => saturate(quiet, 0)).toThrow('drive must be in (0, Infinity), got 0');
  });

  it('accepts the largest finite drive, clipping to a finite output', () => {
    expect(saturate(quiet, Number.MAX_VALUE).every((sample) => Number.isFinite(sample))).toBe(true);
  });

  it('refuses an infinite drive', () => {
    expect(() => saturate(quiet, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
