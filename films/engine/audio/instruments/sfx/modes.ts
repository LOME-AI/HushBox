import { exponentialDecay, sine } from '../../dsp/index.js';
import { add, multiply } from '../voice.js';

import { scaled } from './layer.js';

/** One resonance of a struck body: its frequency as a ratio to the fundamental, its level, and its share of the ring's decay. */
export interface Mode {
  ratio: number;
  level: number;
  decayShare: number;
}

/**
 * Inharmonic modes, the lower ratios an ideal circular membrane's, the upper
 * ones dying a little sooner: rung together and high-passed, they read as
 * struck metal rather than a pitched note.
 */
export const METAL_MODES: readonly Mode[] = [
  { ratio: 1, level: 1, decayShare: 1 },
  { ratio: 1.59, level: 0.8, decayShare: 0.95 },
  { ratio: 2.14, level: 0.7, decayShare: 0.9 },
  { ratio: 2.65, level: 0.6, decayShare: 0.85 },
  { ratio: 3.16, level: 0.5, decayShare: 0.8 },
  { ratio: 4.15, level: 0.4, decayShare: 0.75 },
  { ratio: 5.2, level: 0.3, decayShare: 0.7 },
  { ratio: 6.4, level: 0.2, decayShare: 0.65 },
];

/** The highest a mode may ring: above it a mode adds nothing a listener hears, and it would near the oscillator's Nyquist bound. */
const CEILING_HZ = 20_000;

/**
 * A struck body ringing: one decaying sine per mode, each starting at phase 0 as
 * a resonator's impulse response does. A mode that would ring at 20 kHz or above
 * is left out, so one table of modes serves any fundamental.
 */
export function modalRing(options: {
  hertz: number;
  samples: number;
  /** Seconds for a mode with a decay share of 1 to fall 60 dB. */
  t60: number;
  modes: readonly Mode[];
}): Float32Array {
  const { hertz, samples, t60 } = options;
  let ring: Float32Array = new Float32Array(samples);
  for (const { ratio, level, decayShare } of options.modes) {
    const frequency = hertz * ratio;
    if (frequency < CEILING_HZ) {
      const tone = multiply(
        sine({ frequency, samples }),
        exponentialDecay({ samples, t60: t60 * decayShare })
      );
      ring = add(ring, scaled(tone, level));
    }
  }
  return ring;
}
