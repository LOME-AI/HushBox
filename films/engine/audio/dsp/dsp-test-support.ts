// Measurements the DSP tests share. They use `dmath` like the code they measure,
// so a measured figure is itself bit-reproducible.

import { expect } from 'vitest';

import { cos, log10 } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';

/** A run of samples: `length` of them, starting at `from`. */
export interface Window {
  from: number;
  length: number;
}

/** |X(f)|² of the window at one frequency, by Goertzel's recurrence. */
export function goertzelPower(signal: Float32Array, frequency: number, window: Window): number {
  const coefficient = 2 * cos((2 * Math.PI * frequency) / SAMPLE_RATE);
  let previous = 0;
  let beforePrevious = 0;
  for (const sample of signal.subarray(window.from, window.from + window.length)) {
    const current = sample + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return (
    previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious
  );
}

/** A power ratio in decibels. */
export function decibels(ratio: number): number {
  return 10 * log10(ratio);
}

/**
 * A tone's level in dB relative to a full-scale sine. Exact when the window holds
 * a whole number of the tone's cycles, which a bin-aligned frequency guarantees.
 */
export function toneLevelDb(signal: Float32Array, frequency: number, window: Window): number {
  const amplitude = (2 * Math.sqrt(goertzelPower(signal, frequency, window))) / window.length;
  return 2 * decibels(amplitude);
}

/**
 * Asserts a gain in dB is at least `atLeast` dB of attenuation and still finite:
 * silence measures −Infinity, and a filter that outputs nothing attenuates nothing.
 */
export function expectAttenuated(gainDb: number, atLeast: number): void {
  expect(Number.isFinite(gainDb)).toBe(true);
  expect(gainDb).toBeLessThanOrEqual(-atLeast);
}

/** The summed power of every bin of the window whose frequency lies in (low, high]. */
export function bandPower(
  signal: Float32Array,
  band: { low: number; high: number },
  window: Window
): number {
  const binWidth = SAMPLE_RATE / window.length;
  let power = 0;
  for (let bin = Math.floor(band.low / binWidth) + 1; bin * binWidth <= band.high; bin++) {
    power += goertzelPower(signal, bin * binWidth, window);
  }
  return power;
}

/** The adjacent double to a finite, nonzero x, one step up (+1) or down (−1). */
export function nextAfter(x: number, direction: 1 | -1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const awayFromZero = x > 0 === direction > 0;
  view.setBigInt64(0, view.getBigInt64(0) + (awayFromZero ? 1n : -1n));
  return view.getFloat64(0);
}
