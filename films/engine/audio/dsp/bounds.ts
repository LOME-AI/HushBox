import { SAMPLE_RATE } from '../../time/grid.js';

/** A numeric interval; each end is closed unless marked open. */
export interface Interval {
  min: number;
  max: number;
  minOpen?: boolean;
  maxOpen?: boolean;
}

/** The frequencies a signal sampled at SAMPLE_RATE can carry: 0 Hz up to, not including, Nyquist. */
export const AUDIO_FREQUENCY: Interval = { min: 0, max: SAMPLE_RATE / 2, maxOpen: true };

/** Every positive finite number. */
export const POSITIVE_FINITE: Interval = {
  min: 0,
  max: Number.POSITIVE_INFINITY,
  minOpen: true,
  maxOpen: true,
};

/** [0, ∞): zero and every positive finite number. */
export const NON_NEGATIVE_FINITE: Interval = {
  min: 0,
  max: Number.POSITIVE_INFINITY,
  maxOpen: true,
};

/** Every finite number. */
export const FINITE: Interval = {
  min: Number.NEGATIVE_INFINITY,
  max: Number.POSITIVE_INFINITY,
  minOpen: true,
  maxOpen: true,
};

/** [0, 1]: a level or a proportion. */
export const UNIT: Interval = { min: 0, max: 1 };

/** A loop gain below 1 in magnitude, so whatever recirculates decays. */
export const STABLE_LOOP_GAIN: Interval = { min: -1, max: 1, minOpen: true, maxOpen: true };

/** Whether the value lies in the interval. NaN lies in none. */
export function isInRange(value: number, interval: Interval): boolean {
  const aboveMin = interval.minOpen === true ? value > interval.min : value >= interval.min;
  const belowMax = interval.maxOpen === true ? value < interval.max : value <= interval.max;
  return aboveMin && belowMax;
}

/** The error that names a parameter, the value it was given and the interval it must lie in. */
export function outOfRange(name: string, value: number, interval: Interval): RangeError {
  const open = interval.minOpen === true ? '(' : '[';
  const close = interval.maxOpen === true ? ')' : ']';
  return new RangeError(
    `${name} must be in ${open}${String(interval.min)}, ${String(interval.max)}${close}, got ${String(value)}`
  );
}

/** The value, when it lies in the interval; otherwise a RangeError naming the parameter. */
export function requireInRange(name: string, value: number, interval: Interval): number {
  if (!isInRange(value, interval)) {
    throw outOfRange(name, value, interval);
  }
  return value;
}

/** The value, when it is a whole number of samples (a safe integer, zero or more). */
export function requireSampleCount(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a whole number of samples, zero or more, got ${String(value)}`
    );
  }
  return value;
}
