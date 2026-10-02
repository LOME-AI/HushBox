import { z } from 'zod';

import { membrane } from '../drum.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, mono, secondsToSamples } from '../voice.js';

import { bursts } from './burst.js';
import { scaled } from './layer.js';

import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';

const params = z.object({
  /** Hz the snap's crack rings around. */
  toneHz: z.number().min(800).max(4000).default(2100),
  /** Seconds for the crack to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.02).max(0.3).default(0.06),
});

/** The fingers' slip: a burst of a few milliseconds above 5 kHz. */
const SLIP: Burst = {
  t60: 0.003,
  filter: { mode: 'highpass', cutoff: 5000, resonance: 0 },
  level: 0.6,
};
const CRACK_RESONANCE = 0.55;
/** The finger striking the palm: a low knock under the crack, dying in a share of its decay. */
const PALM = { startHz: 420, endHz: 260, pitchT60: 0.01, decayShare: 0.4, level: 0.25 };

/** A dry finger snap: a slip, a resonant crack and the knock of the palm. */
export const snap: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const crack: Burst = {
      t60: decay,
      filter: { mode: 'bandpass', cutoff: toneHz, resonance: CRACK_RESONANCE },
      level: 1,
    };
    const palm = membrane({
      samples,
      startHz: PALM.startHz,
      endHz: PALM.endHz,
      pitchT60: PALM.pitchT60,
      t60: decay * PALM.decayShare,
    });
    return anchoredAtStart(
      mono(add(bursts(samples, [SLIP, crack], rand), scaled(palm, PALM.level)))
    );
  },
});
