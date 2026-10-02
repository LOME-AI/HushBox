import { AUDIO_FREQUENCY, requireInRange } from './bounds.js';
import { controlInRange, requireControl } from './buffer.js';
import { prewarp } from './prewarp.js';

import type { Interval } from './bounds.js';
import type { Control } from './buffer.js';

export type FilterMode = 'lowpass' | 'highpass' | 'bandpass' | 'notch';

export interface SvfOptions {
  mode: FilterMode;
  /** Hz, in [0, SAMPLE_RATE / 2): constant, or one value per sample. */
  cutoff: Control;
  /**
   * In [0, 1): 0 is critically damped (q = ½), and q = 1 / (2 − 2·resonance)
   * grows without bound towards 1, where the filter would ring forever.
   */
  resonance: number;
}

const RESONANCE: Interval = { min: 0, max: 1, maxOpen: true };

/** The TPT update's three gains for a prewarped cutoff and a damping of 1/q. */
interface Gains {
  a1: number;
  a2: number;
  a3: number;
}

function gainsFor(cutoff: number, damping: number): Gains {
  const g = prewarp(cutoff);
  const a1 = 1 / (1 + g * (g + damping));
  const a2 = g * a1;
  return { a1, a2, a3: g * a2 };
}

/** Each mode's output from the input, the band and low states, and the damping. */
const OUTPUTS: Record<
  FilterMode,
  (input: number, band: number, low: number, damping: number) => number
> = {
  lowpass: (_input, _band, low) => low,
  highpass: (input, band, low, damping) => input - damping * band - low,
  // Scaled by the damping so the pass band peaks at unity gain whatever the q.
  bandpass: (_input, band, _low, damping) => damping * band,
  notch: (input, band, _low, damping) => input - damping * band,
};

/**
 * A topology-preserving-transform (trapezoidal-integrator) state-variable
 * filter: 12 dB per octave, its cutoff exact through the bilinear prewarp,
 * stable while the cutoff moves every sample.
 */
export function svf(input: Float32Array, options: SvfOptions): Float32Array {
  const { mode, cutoff } = options;
  const resonance = requireInRange('resonance', options.resonance, RESONANCE);
  requireControl('cutoff', cutoff, input.length, AUDIO_FREQUENCY);
  const damping = 2 * (1 - resonance);
  const select = OUTPUTS[mode];
  const output = new Float32Array(input.length);
  // The two integrators' trapezoidal states.
  let bandState = 0;
  let lowState = 0;
  let current = Number.NaN;
  let gains: Gains = { a1: 0, a2: 0, a3: 0 };
  for (const [index, sample] of input.entries()) {
    const hertz = controlInRange('cutoff', cutoff, index, AUDIO_FREQUENCY);
    if (hertz !== current) {
      gains = gainsFor(hertz, damping);
      current = hertz;
    }
    const drive = sample - lowState;
    const band = gains.a1 * bandState + gains.a2 * drive;
    const low = lowState + gains.a2 * bandState + gains.a3 * drive;
    output[index] = select(sample, band, low, damping);
    bandState = 2 * band - bandState;
    lowState = 2 * low - lowState;
  }
  return output;
}
