import type { StereoBuffer } from '../audio/dsp/index.js';

/** A named instant in a signal, at an exact sample index. */
export interface AnalysisCue {
  readonly id: string;
  readonly sample: number;
}

/** The signal's length in samples; refuses an empty signal and channels of unequal length. */
export function requireStereo(signal: StereoBuffer): number {
  const { length } = signal.left;
  if (signal.right.length !== length) {
    throw new RangeError(
      `stereo channels differ in length: left ${String(length)}, right ${String(signal.right.length)} samples`
    );
  }
  if (length === 0) {
    throw new RangeError('the signal is empty: analysis needs at least one sample');
  }
  return length;
}

/** Refuses a cue that is not on a sample from the signal's first to one past its last. */
export function requireCueSample(cue: AnalysisCue, length: number): void {
  if (!Number.isInteger(cue.sample) || cue.sample < 0 || cue.sample > length) {
    throw new RangeError(
      `cue "${cue.id}" at sample ${String(cue.sample)} is not an integer sample in [0, ${String(length)}]`
    );
  }
}

/** The sample at `index`, or 0 outside the array: a signal is silent past both its ends. */
export function sampleAt(samples: Float32Array | Float64Array, index: number): number {
  return samples[index] ?? 0;
}
