import { z } from 'zod';

import { pitchedHit } from './drum.js';
import { defineInstrument } from './instrument.js';
import { secondsToSamples } from './voice.js';

import type { PitchedHitOptions } from './drum.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  /** Hz the pitch settles on. */
  toneHz: z.number().min(50).max(400).default(110),
  /** Seconds for the body to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.05).max(3).default(0.7),
});

/** The head starts this far above its tone and falls to it with a 43 ms time constant. */
const SWEEP = 1.5;
const PITCH_T60 = 0.3;

/** The stick: a short burst band-passed around 1.5 kHz, some 12 dB under the body. */
const STICK: PitchedHitOptions['attack'] = {
  t60: 0.01,
  filter: { mode: 'bandpass', cutoff: 1500, resonance: 0.2 },
  level: 0.25,
};
const DRIVE = 1.5;

/** A tom: a membrane falling to its tone, a stick attack, and gentle saturation. */
export const tom: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    return pitchedHit(
      {
        samples,
        startHz: toneHz * SWEEP,
        endHz: toneHz,
        pitchT60: PITCH_T60,
        t60: decay,
        attack: STICK,
        drive: DRIVE,
      },
      rand
    );
  },
});
