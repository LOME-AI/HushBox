import { z } from 'zod';

import { exponentialDecay } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, mono, multiply, secondsToSamples } from '../voice.js';

import { burst } from './burst.js';
import { crestSine } from './layer.js';

import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';

const params = z.object({
  /** Hz of the blip. */
  toneHz: z.number().min(1000).max(6000).default(3000),
  /** Seconds for the blip to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.003).max(0.1).default(0.015),
});

/** The contact's click under the blip: a burst of a couple of milliseconds above 5 kHz. */
const CLICK: Burst = {
  t60: 0.002,
  filter: { mode: 'highpass', cutoff: 5000, resonance: 0 },
  level: 0.25,
};

/** A UI tick: a short sine blip struck at its crest, over a contact click. */
export const tick: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const blip = multiply(
      crestSine({ frequency: toneHz, samples }),
      exponentialDecay({ samples, t60: decay })
    );
    return anchoredAtStart(mono(add(blip, burst(samples, CLICK, rand))));
  },
});
