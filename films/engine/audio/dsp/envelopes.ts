import { exp, log } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';

import { POSITIVE_FINITE, UNIT, requireInRange, requireSampleCount } from './bounds.js';

/** A linear ADSR. Every length is a whole number of samples; `sustain` is a level in [0, 1]. */
export interface AdsrOptions {
  attack: number;
  decay: number;
  sustain: number;
  /** Samples from note-on to note-off: the release starts here, wherever the envelope has got to. */
  hold: number;
  release: number;
}

/** ln(1000): a level has fallen 60 dB when it has shrunk by this in natural-log units. */
export const LN_1000 = log(1000);

/** The envelope's level at a sample while the gate is held. */
function gateLevel(index: number, options: AdsrOptions): number {
  if (index < options.attack) {
    return index / options.attack;
  }
  const intoDecay = index - options.attack;
  if (intoDecay < options.decay) {
    return 1 - (1 - options.sustain) * (intoDecay / options.decay);
  }
  return options.sustain;
}

/** Rises from 0 to 1, falls to the sustain level, holds it, then falls to 0: `hold + release` samples. */
export function adsr(options: AdsrOptions): Float32Array {
  for (const key of ['attack', 'decay', 'hold', 'release'] as const) {
    requireSampleCount(key, options[key]);
  }
  requireInRange('sustain', options.sustain, UNIT);
  const { hold, release } = options;
  const output = new Float32Array(hold + release);
  for (let index = 0; index < hold; index++) {
    output[index] = gateLevel(index, options);
  }
  const releaseFrom = gateLevel(hold, options);
  for (let step = 0; step < release; step++) {
    output[hold + step] = releaseFrom * (1 - step / release);
  }
  return output;
}

/** Falls from 1 by a constant ratio per sample, reaching −60 dB after `t60` seconds. */
export function exponentialDecay(options: { samples: number; t60: number }): Float32Array {
  const samples = requireSampleCount('samples', options.samples);
  const t60 = requireInRange('t60', options.t60, POSITIVE_FINITE);
  const output = new Float32Array(samples);
  // Divided per sample rather than folded into one rate, which overflows to
  // Infinity for a subnormal t60 and makes the first sample Infinity × 0.
  const t60Samples = t60 * SAMPLE_RATE;
  for (let index = 0; index < samples; index++) {
    output[index] = exp(-(LN_1000 * index) / t60Samples);
  }
  return output;
}

/** Moves from `from` to `to`, both positive, by a constant ratio per sample: a glide even in pitch or level. */
export function exponentialRamp(options: {
  from: number;
  to: number;
  samples: number;
}): Float32Array {
  const samples = requireSampleCount('samples', options.samples);
  const from = requireInRange('from', options.from, POSITIVE_FINITE);
  const to = requireInRange('to', options.to, POSITIVE_FINITE);
  const output = new Float32Array(samples);
  const logRatio = log(to / from);
  const steps = Math.max(samples - 1, 1);
  for (let index = 0; index < samples; index++) {
    output[index] = from * exp((logRatio * index) / steps);
  }
  return output;
}
