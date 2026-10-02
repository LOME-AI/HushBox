import { AUDIO_FREQUENCY, requireInRange } from './bounds.js';
import { prewarp } from './prewarp.js';

export interface OnePoleOptions {
  mode: 'lowpass' | 'highpass';
  /** Hz, in [0, SAMPLE_RATE / 2). */
  cutoff: number;
}

/** A first-order high-pass at 10 Hz, below the audible band. */
const DC_BLOCK_CUTOFF = 10;

/**
 * A first-order topology-preserving-transform filter as a per-sample step, for
 * a caller running it inside its own loop: 6 dB per octave, its cutoff exact
 * through the bilinear prewarp.
 */
export function createOnePole(options: OnePoleOptions): (sample: number) => number {
  const g = prewarp(requireInRange('cutoff', options.cutoff, AUDIO_FREQUENCY));
  const gain = g / (1 + g);
  const highpass = options.mode === 'highpass';
  let state = 0;
  return (sample) => {
    const step = (sample - state) * gain;
    const low = step + state;
    state = low + step;
    return highpass ? sample - low : low;
  };
}

/** The input through a one-pole filter. */
export function onePole(input: Float32Array, options: OnePoleOptions): Float32Array {
  const step = createOnePole(options);
  return input.map((sample) => step(sample));
}

/** Removes a constant offset and subsonic drift. */
export function dcBlock(input: Float32Array): Float32Array {
  return onePole(input, { mode: 'highpass', cutoff: DC_BLOCK_CUTOFF });
}
