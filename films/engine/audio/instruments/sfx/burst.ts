import { exponentialDecay } from '../../dsp/index.js';
import { excite } from '../drum.js';
import { add, secondsToSamples } from '../voice.js';

import { placedAt, scaled } from './layer.js';

import type { SvfOptions } from '../../dsp/index.js';

/** A struck noise burst: falling 60 dB in `t60` seconds, through `filter`, at `level`. */
export interface Burst {
  t60: number;
  filter: SvfOptions;
  level: number;
}

/**
 * A burst of `samples` samples: the drums' excitation, a strike on the first
 * sample plus noise under an exponential decay, filtered. The strike outweighs
 * the noise there, so the burst is heard from its first sample whatever the seed.
 */
export function burst(samples: number, spec: Burst, rand: () => number): Float32Array {
  const envelope = exponentialDecay({ samples, t60: spec.t60 });
  return scaled(excite({ envelope, filter: spec.filter }, rand), spec.level);
}

/** A burst that starts `at` seconds into the sound, or on its first sample when `at` is omitted. */
export interface PlacedBurst extends Burst {
  at?: number;
}

/**
 * Bursts summed into `samples` samples, each drawing its noise from `rand` in
 * turn; whatever of a burst falls past the end is dropped.
 */
export function bursts(
  samples: number,
  specs: readonly PlacedBurst[],
  rand: () => number
): Float32Array {
  let sum: Float32Array = new Float32Array(samples);
  for (const spec of specs) {
    const at = Math.min(secondsToSamples(spec.at ?? 0), samples);
    sum = add(sum, placedAt(burst(samples - at, spec, rand), at, samples));
  }
  return sum;
}
