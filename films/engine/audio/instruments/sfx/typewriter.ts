import { z } from 'zod';

import { membrane } from '../drum.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, mono, secondsToSamples } from '../voice.js';

import { bursts } from './burst.js';
import { scaled } from './layer.js';

import type { Instrument } from '../instrument.js';
import type { Burst, PlacedBurst } from './burst.js';

const params = z.object({
  /** Hz the machine's body knocks around. */
  toneHz: z.number().min(800).max(4000).default(1900),
  /** Seconds for the knock to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.02).max(0.3).default(0.08),
});

/** The key's strike: a burst of a few milliseconds above 2.5 kHz. */
const STRIKE: Burst = {
  t60: 0.004,
  filter: { mode: 'highpass', cutoff: 2500, resonance: 0 },
  level: 0.6,
};
const KNOCK_RESONANCE = 0.75;
/** The type bar slapping the platen, 11 ms after the key: brighter and shorter than the strike. */
const SLAP: PlacedBurst = {
  at: 0.011,
  t60: 0.003,
  filter: { mode: 'highpass', cutoff: 3500, resonance: 0 },
  level: 0.6,
};
/** The key bottoming out: a low thunk dying in a share of the knock's decay. */
const THUNK = { startHz: 260, endHz: 170, pitchT60: 0.02, decayShare: 0.6, level: 0.5 };

/** One typewriter key: the strike, the body's knock, the key's thunk and the type bar's slap. */
export const typewriter: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const knock: Burst = {
      t60: decay,
      filter: { mode: 'bandpass', cutoff: toneHz, resonance: KNOCK_RESONANCE },
      level: 1,
    };
    const thunk = membrane({
      samples,
      startHz: THUNK.startHz,
      endHz: THUNK.endHz,
      pitchT60: THUNK.pitchT60,
      t60: decay * THUNK.decayShare,
    });
    return anchoredAtStart(
      mono(add(bursts(samples, [STRIKE, knock, SLAP], rand), scaled(thunk, THUNK.level)))
    );
  },
});
