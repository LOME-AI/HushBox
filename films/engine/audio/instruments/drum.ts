import { exponentialDecay, saturate, sine, svf, whiteNoise } from '../dsp/index.js';

import { add, anchoredAtStart, impulse, mono, multiply } from './voice.js';

import type { SvfOptions } from '../dsp/index.js';
import type { Rendered } from './instrument.js';

/**
 * The strike's height against noise samples, which lie in [−1, 1): under an
 * envelope no louder than 1 it outweighs every one of them.
 */
const STRIKE = 2;

interface MembraneOptions {
  samples: number;
  /** Hz at the hit, falling towards `endHz`. */
  startHz: number;
  endHz: number;
  /** Seconds for the pitch to cover all but a thousandth of its fall. */
  pitchT60: number;
  /** Seconds for the level to fall 60 dB. */
  t60: number;
}

/** A struck membrane: a sine whose pitch falls exponentially from `startHz` to `endHz`, under an exponential decay. */
export function membrane(options: MembraneOptions): Float32Array {
  const { samples, startHz, endHz } = options;
  const fall = exponentialDecay({ samples, t60: options.pitchT60 });
  const frequency = fall.map((remaining) => endHz + (startHz - endHz) * remaining);
  return multiply(sine({ frequency, samples }), exponentialDecay({ samples, t60: options.t60 }));
}

/**
 * A hit's excitation, filtered: a strike on the first sample plus noise under
 * the envelope. The strike outweighs any noise sample the envelope lets through,
 * so the first sample is never silent whatever the seed, and the attack is heard
 * exactly on the sample it is scheduled for.
 */
export function excite(
  options: { envelope: Float32Array; filter: SvfOptions },
  rand: () => number
): Float32Array {
  const { envelope, filter } = options;
  const noise = multiply(whiteNoise(envelope.length, rand), envelope);
  return svf(add(noise, impulse(envelope.length, STRIKE)), filter);
}

export interface PitchedHitOptions extends MembraneOptions {
  /** The attack laid over the membrane: a noise burst falling 60 dB in `t60` seconds, filtered, at `level`. */
  attack: { t60: number; filter: SvfOptions; level: number };
  /** The saturator's drive over the whole hit. */
  drive: number;
}

/** A tuned drum: a membrane with an attack over it, saturated together, the same in both channels. */
export function pitchedHit(options: PitchedHitOptions, rand: () => number): Rendered {
  const { samples, attack } = options;
  const struck = excite(
    { envelope: exponentialDecay({ samples, t60: attack.t60 }), filter: attack.filter },
    rand
  ).map((sample) => sample * attack.level);
  return anchoredAtStart(mono(saturate(add(membrane(options), struck), options.drive)));
}
