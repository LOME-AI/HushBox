import { isInRange, outOfRange, requireInRange, requireSampleCount } from './bounds.js';

import type { Interval } from './bounds.js';

export interface StereoBuffer {
  left: Float32Array;
  right: Float32Array;
}

/** Refuses a stereo buffer whose channels differ in length. */
export function requireEqualChannels(buffer: StereoBuffer): void {
  if (buffer.left.length !== buffer.right.length) {
    throw new RangeError(
      `left and right hold ${String(buffer.left.length)} and ${String(buffer.right.length)} samples: a stereo buffer needs equal channels`
    );
  }
}

/** A parameter held constant, or given one value per output sample. */
export type Control = number | Float32Array;

/** Two silent channels of `samples` samples each. */
export function createStereo(samples: number): StereoBuffer {
  requireSampleCount('samples', samples);
  return { left: new Float32Array(samples), right: new Float32Array(samples) };
}

/** The sample at an index the caller has bounded by the buffer's length. */
export function sampleAt(buffer: ArrayLike<number>, index: number): number {
  const sample = buffer[index];
  if (sample === undefined) {
    throw new RangeError(
      `sample ${String(index)} is outside a buffer of ${String(buffer.length)} samples`
    );
  }
  return sample;
}

/** A control's value at one output sample. */
export function controlAt(control: Control, index: number): number {
  return typeof control === 'number' ? control : sampleAt(control, index);
}

/**
 * Refuses a constant control outside the interval, and a per-sample control
 * whose length differs from the output's; per-sample values are checked as they
 * are read, by {@link controlInRange}.
 */
export function requireControl(
  name: string,
  control: Control,
  samples: number,
  interval: Interval
): void {
  if (typeof control === 'number') {
    requireInRange(name, control, interval);
  } else if (control.length !== samples) {
    throw new RangeError(
      `${name} holds ${String(control.length)} values for ${String(samples)} samples: a per-sample control needs one value per sample`
    );
  }
}

/** A control's value at one sample, refused, naming the sample, when it lies outside the interval. */
export function controlInRange(
  name: string,
  control: Control,
  index: number,
  interval: Interval
): number {
  const value = controlAt(control, index);
  if (!isInRange(value, interval)) {
    throw outOfRange(`${name}[${String(index)}]`, value, interval);
  }
  return value;
}
