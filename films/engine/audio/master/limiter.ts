import { exp, sin } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, sampleAt } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';

/**
 * Samples of lookahead: 2 ms. The gain ramps down over this span before a peak,
 * so no peak is met with a step in gain.
 */
export const LIMITER_LOOKAHEAD = Math.round(0.002 * SAMPLE_RATE);

/** Seconds: the time constant of the gain's return to unity after a peak. */
export const LIMITER_RELEASE = 0.06;

/** Interpolated points per sample in the key. */
const OVERSAMPLING = 4;
/** Input samples on each side of an interpolated point that its filter reads. */
const HALF_TAPS = 8;
/** The Kaiser window's shape parameter: sidelobes near 45 dB down. */
const KAISER_BETA = 6;

/** The zeroth-order modified Bessel function of the first kind, by its power series. */
function besselI0(x: number): number {
  const quarterSquare = (x * x) / 4;
  let term = 1;
  let sum = 1;
  let k = 0;
  while (term > sum * 1e-17) {
    k++;
    term *= quarterSquare / (k * k);
    sum += term;
  }
  return sum;
}

/** The Kaiser window at a distance from its centre, zero at HALF_TAPS and beyond. */
function kaiser(distance: number): number {
  const ratio = distance / HALF_TAPS;
  return besselI0(KAISER_BETA * Math.sqrt(1 - ratio * ratio)) / besselI0(KAISER_BETA);
}

/**
 * The taps that interpolate the point `fraction` of a sample after sample i,
 * reading samples i − HALF_TAPS + 1 through i + HALF_TAPS: a Kaiser-windowed
 * sinc, normalised to unit gain at DC. `fraction` is never whole, so the sinc
 * never divides by zero.
 */
function tapsAt(fraction: number): Float64Array {
  const taps = new Float64Array(2 * HALF_TAPS);
  let sum = 0;
  for (let tap = 0; tap < taps.length; tap++) {
    const distance = fraction - (tap - HALF_TAPS + 1);
    const value = (sin(Math.PI * distance) / (Math.PI * distance)) * kaiser(distance);
    taps[tap] = value;
    sum += value;
  }
  return taps.map((value) => value / sum);
}

const PHASES = [1, 2, 3].map((phase) => tapsAt(phase / OVERSAMPLING));

/** The largest magnitude over sample i and the interpolated points between it and sample i + 1. */
function intervalPeak(samples: Float32Array, index: number): number {
  let peak = Math.abs(sampleAt(samples, index));
  for (const taps of PHASES) {
    let sum = 0;
    for (const [tap, weight] of taps.entries()) {
      // The signal is silent before its start and past its end.
      sum += weight * (samples[index + tap - HALF_TAPS + 1] ?? 0);
    }
    peak = Math.max(peak, Math.abs(sum));
  }
  return peak;
}

/**
 * Per sample, the largest magnitude the reconstructed signal reaches in either
 * channel within a sample on either side of it, from a 4× interpolation. A
 * limiter keyed on it meets the peaks between samples as well as the samples.
 * It is the limiter's own estimate: the loudness meter in the analysis tree,
 * with its longer filter, stays the authority on the master's true peak.
 */
export function truePeakKey(input: StereoBuffer): Float64Array {
  const { length } = input.left;
  const intervals = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    intervals[index] = Math.max(intervalPeak(input.left, index), intervalPeak(input.right, index));
  }
  return intervals.map((peak, index) =>
    Math.max(peak, index === 0 ? 0 : sampleAt(intervals, index - 1))
  );
}

/**
 * Each value's minimum over the `width` values that start at it; the windows
 * that run past the end cover only the values that remain. Van Herk and
 * Gil-Werman's block method, linear in the length whatever the width.
 */
export function forwardMinimum(values: Float64Array, width: number): Float64Array {
  const length = values.length + width - 1;
  const padded = new Float64Array(length).fill(Number.POSITIVE_INFINITY);
  padded.set(values);
  const sinceBlockStart = new Float64Array(length);
  const untilBlockEnd = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    const value = sampleAt(padded, index);
    sinceBlockStart[index] =
      index % width === 0 ? value : Math.min(sampleAt(sinceBlockStart, index - 1), value);
  }
  for (let index = length - 1; index >= 0; index--) {
    const value = sampleAt(padded, index);
    const blockEnds = index === length - 1 || (index + 1) % width === 0;
    untilBlockEnd[index] = blockEnds ? value : Math.min(sampleAt(untilBlockEnd, index + 1), value);
  }
  return values.map((_, index) =>
    Math.min(sampleAt(untilBlockEnd, index), sampleAt(sinceBlockStart, index + width - 1))
  );
}

export interface LimitOptions {
  /** Linear gain into the limiter. */
  gain: number;
  /** Linear level no key peak may exceed after the gain. */
  ceiling: number;
}

/**
 * A lookahead limiter after Signalsmith's design: the gain each sample's key
 * requires, held at its minimum over the lookahead ahead of it, released
 * exponentially but never above that minimum, then averaged over the trailing
 * lookahead. Every average spans only samples whose held minimum already covers
 * the peak it ends on, so no gain exceeds what its sample needs. Offline, the
 * future is read directly, so there is no latency to compensate.
 */
export function limit(input: StereoBuffer, key: Float64Array, options: LimitOptions): StereoBuffer {
  const { gain, ceiling } = options;
  const required = key.map((peak) => (peak * gain > ceiling ? ceiling / (peak * gain) : 1));
  const held = forwardMinimum(required, LIMITER_LOOKAHEAD);
  const pole = exp(-1 / (LIMITER_RELEASE * SAMPLE_RATE));
  // Before the first sample the gain already sits at what the first lookahead
  // needs, so a peak too early for the ramp is still covered.
  const start = held[0] ?? 1;
  const recent = new Float64Array(LIMITER_LOOKAHEAD).fill(start);
  const output = createStereo(key.length);
  let released = start;
  let windowSum = start * LIMITER_LOOKAHEAD;
  for (const [index, floor] of held.entries()) {
    released = Math.min(floor, 1 - (1 - released) * pole);
    const slot = index % LIMITER_LOOKAHEAD;
    windowSum += released - sampleAt(recent, slot);
    recent[slot] = released;
    const applied = (gain * windowSum) / LIMITER_LOOKAHEAD;
    output.left[index] = sampleAt(input.left, index) * applied;
    output.right[index] = sampleAt(input.right, index) * applied;
  }
  return output;
}
