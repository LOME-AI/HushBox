import { z } from 'zod';

import { pitchedHit } from './drum.js';
import { defineInstrument } from './instrument.js';
import { secondsToSamples } from './voice.js';

import type { PitchedHitOptions } from './drum.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  /** Hz at the hit. */
  startHz: z.number().min(40).max(1000).default(180),
  /** Hz the pitch settles on: the note the kick is tuned to. */
  endHz: z.number().min(20).max(200).default(48),
  /** Seconds for the body to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.05).max(4).default(0.9),
  /** The saturator's drive: more thickens the body with odd harmonics. */
  drive: z.number().min(0.5).max(8).default(2),
});

/** Seconds for the pitch to cover all but a thousandth of its fall: a time constant of 35 ms. */
const PITCH_T60 = 0.24;

/** The beater's click: a noise burst of a few milliseconds above 3 kHz, some 10 dB under the body. */
const CLICK: PitchedHitOptions['attack'] = {
  t60: 0.005,
  filter: { mode: 'highpass', cutoff: 3000, resonance: 0 },
  level: 0.3,
};

/** A kick drum: a sine falling in pitch to its tuned note, a beater click, and saturation. */
export const kick: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ startHz, endHz, decay, drive }, { rand }) {
    const samples = secondsToSamples(decay);
    return pitchedHit(
      { samples, startHz, endHz, pitchT60: PITCH_T60, t60: decay, attack: CLICK, drive },
      rand
    );
  },
});
