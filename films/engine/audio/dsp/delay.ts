import { STABLE_LOOP_GAIN, requireInRange, requireSampleCount } from './bounds.js';
import { controlInRange, requireControl, sampleAt } from './buffer.js';

import type { Interval } from './bounds.js';
import type { Control } from './buffer.js';

/** A ring of the most recent samples, read back at any delay, whole or fractional. */
export interface DelayLine {
  write(sample: number): void;
  /** The signal `delay` samples before the newest written, in [0, capacity − 1]; linear between samples. */
  tap(delay: number): number;
}

export interface DelayOptions {
  /** Samples, in [1, input length]: constant, or one value per sample. */
  time: Control;
  /** In (−1, 1). */
  feedback: number;
}

export function createDelayLine(capacity: number): DelayLine {
  requireSampleCount('capacity', capacity);
  if (capacity === 0) {
    throw new RangeError('capacity must hold at least one sample, got 0');
  }
  const samples = new Float64Array(capacity);
  const reach: Interval = { min: 0, max: capacity - 1 };
  let newest = capacity - 1;
  const back = (steps: number): number => sampleAt(samples, (newest - steps + capacity) % capacity);
  return {
    write(sample) {
      newest = (newest + 1) % capacity;
      samples[newest] = sample;
    },
    tap(delay) {
      requireInRange('delay', delay, reach);
      const whole = Math.floor(delay);
      const fraction = delay - whole;
      const near = back(whole);
      return fraction === 0 ? near : near + (back(whole + 1) - near) * fraction;
    },
  };
}

/** Delay times from one sample to the input's length: a longer delay would only ever output silence. */
export function delayRange(input: Float32Array): Interval {
  return { min: 1, max: Math.max(input.length, 1) };
}

/**
 * The input's echoes alone, without the dry signal: each arrives `time` samples
 * after the last, scaled by `feedback`. The output is as long as the input;
 * pad the input with silence to keep the tail.
 */
export function feedbackDelay(input: Float32Array, options: DelayOptions): Float32Array {
  const feedback = requireInRange('feedback', options.feedback, STABLE_LOOP_GAIN);
  const range = delayRange(input);
  requireControl('time', options.time, input.length, range);
  const line = createDelayLine(range.max);
  const output = new Float32Array(input.length);
  for (const [index, sample] of input.entries()) {
    // The line's newest sample is one step old by now, hence time − 1.
    const echo = line.tap(controlInRange('time', options.time, index, range) - 1);
    line.write(sample + feedback * echo);
    output[index] = echo;
  }
  return output;
}
