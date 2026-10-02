import { z } from 'zod';

import { exp2 } from '../../../dmath/dmath.js';
import { exponentialDecay } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, mono, multiply, secondsToSamples } from '../voice.js';

import { burst } from './burst.js';
import { crestSine } from './layer.js';

import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';

const params = z.object({
  /** Hz the pop starts at. */
  fromHz: z.number().min(100).max(1000).default(250),
  /** How far it sweeps up, in octaves. */
  octaves: z.number().min(0).max(4).default(2),
  /** Seconds for the level to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.01).max(0.3).default(0.06),
});

/** The pitch covers all but a thousandth of its sweep in this share of the decay. */
const SWEEP_SHARE = 0.5;
/** A faint click at the burst: a couple of milliseconds above 4 kHz. */
const CLICK: Burst = {
  t60: 0.002,
  filter: { mode: 'highpass', cutoff: 4000, resonance: 0 },
  level: 0.2,
};

/** A pop: a sine struck at its crest whose pitch sweeps quickly up, over a faint click. */
export const pop: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ fromHz, octaves, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const toHz = fromHz * exp2(octaves);
    const frequency = exponentialDecay({ samples, t60: decay * SWEEP_SHARE }).map(
      (remaining) => toHz + (fromHz - toHz) * remaining
    );
    const tone = multiply(
      crestSine({ frequency, samples }),
      exponentialDecay({ samples, t60: decay })
    );
    return anchoredAtStart(mono(add(tone, burst(samples, CLICK, rand))));
  },
});
