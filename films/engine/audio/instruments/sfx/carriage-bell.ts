import { z } from 'zod';

import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, mono, secondsToSamples } from '../voice.js';

import { burst } from './burst.js';
import { modalRing } from './modes.js';

import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';
import type { Mode } from './modes.js';

const params = z.object({
  /** Hz of the bell's lowest partial. */
  toneHz: z.number().min(1000).max(6000).default(2700),
  /** Seconds for the lowest partial to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.2).max(4).default(1.6),
});

/** The bell's inharmonic partials, those of a struck bar, the upper ones dying sooner. */
const BELL_MODES: readonly Mode[] = [
  { ratio: 1, level: 1, decayShare: 1 },
  { ratio: 2.756, level: 0.5, decayShare: 0.6 },
  { ratio: 5.404, level: 0.25, decayShare: 0.35 },
  { ratio: 8.933, level: 0.12, decayShare: 0.2 },
];
/** The hammer's tick on the bell: a burst of a few milliseconds above 4 kHz. */
const HAMMER: Burst = {
  t60: 0.003,
  filter: { mode: 'highpass', cutoff: 4000, resonance: 0 },
  level: 0.25,
};

/** A typewriter's carriage-return bell: a small struck bell's partials and the hammer's tick. */
export const carriageBell: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const ring = modalRing({ hertz: toneHz, samples, t60: decay, modes: BELL_MODES });
    return anchoredAtStart(mono(add(ring, burst(samples, HAMMER, rand))));
  },
});
