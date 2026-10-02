import { z } from 'zod';

import { exponentialDecay, sine } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { anchoredAtStart, freeRunning, gate, mono, multiply, secondsToSamples } from '../voice.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  /** Hz the pulse settles on. */
  toneHz: z.number().min(20).max(120).default(45),
  /** Seconds for the pulse to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.1).max(4).default(0.7),
});

/** The pulse's punch: its pitch starts half again above its tone and settles within 80 ms. */
const PUNCH = { ratio: 1.5, pitchT60: 0.08 };
/** Seconds of the linear rise, so a pulse this low starts without a click. */
const ATTACK = 0.004;

/** A sub pulse: a low sine that punches in a little sharp, settles on its tone and decays. */
export const subPulse: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const frequency = exponentialDecay({ samples, t60: PUNCH.pitchT60 }).map(
      (remaining) => toneHz * (1 + (PUNCH.ratio - 1) * remaining)
    );
    const tone = freeRunning(sine, { frequency, samples, leadHz: toneHz * PUNCH.ratio }, rand);
    const envelope = multiply(
      gate({ samples, attack: secondsToSamples(ATTACK), release: 0 }),
      exponentialDecay({ samples, t60: decay })
    );
    return anchoredAtStart(mono(multiply(tone, envelope)));
  },
});
