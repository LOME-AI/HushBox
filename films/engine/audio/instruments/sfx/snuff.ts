import { z } from 'zod';

import { exponentialDecay, exponentialRamp, svf, whiteNoise } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { anchoredAtStart, gate, multiply, secondsToSamples } from '../voice.js';

import { decorrelated } from './layer.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  /** Hz the breath is centred on. */
  toneHz: z.number().min(300).max(3000).default(1100),
  /** Seconds for the breath to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.05).max(1).default(0.25),
});

/** Seconds of the breath's rise. */
const ATTACK = 0.005;
const BREATH_RESONANCE = 0.2;
/** The breath darkens as it dies: a low-pass falling from 2.5 times its tone to 0.6 times it. */
const DARKEN = { from: 2.5, to: 0.6 };

/** A candle snuffed: a short breathy puff of band-passed noise that darkens as it dies. */
export const snuff: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const envelope = multiply(
      gate({ samples, attack: secondsToSamples(ATTACK), release: 0 }),
      exponentialDecay({ samples, t60: decay })
    );
    const cutoff = exponentialRamp({
      from: toneHz * DARKEN.from,
      to: toneHz * DARKEN.to,
      samples,
    });
    const breath = (): Float32Array =>
      multiply(
        svf(
          svf(whiteNoise(samples, rand), {
            mode: 'bandpass',
            cutoff: toneHz,
            resonance: BREATH_RESONANCE,
          }),
          { mode: 'lowpass', cutoff, resonance: 0 }
        ),
        envelope
      );
    return anchoredAtStart(decorrelated(breath));
  },
});
