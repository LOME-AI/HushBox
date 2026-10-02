import { z } from 'zod';

import { cos } from '../../../dmath/dmath.js';
import { frameToSample } from '../../../time/grid.js';
import { pinkNoise, sine, svf } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import {
  add,
  anchoredAtStart,
  beatsToSamples,
  freeRunning,
  gate,
  multiply,
  secondsToSamples,
} from '../voice.js';

import { bedBeatsSchema } from './bed.js';
import { decorrelated, scaled } from './layer.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  beats: bedBeatsSchema(4),
  /** Hz of the low oscillator under the noise. */
  toneHz: z.number().min(20).max(80).default(36),
  /** Breaths per beat: each breath swells from its trough to its crest and back. */
  breathRate: z
    .number()
    .min(1 / 16)
    .max(4)
    .default(0.25),
});

/**
 * A breath opens the noise's low-pass from 70 Hz to 230 Hz and lifts the level
 * from 0.3 to full, and closes them again.
 */
const BREATH = { closedHz: 70, openHz: 160, floor: 0.3, resonance: 0.25 };
const TONE_LEVEL = 0.35;
/** Seconds the rumble takes to rise from silence and to fall back to it. */
const FADE = 0.4;

/**
 * The breath at every sample, 0 at a trough and 1 at a crest, as a raised
 * cosine over a period of whole samples counted from the rumble's start, so it
 * starts on a trough. The period is the beat's samples over the breath rate,
 * rounded to a whole sample: the breaths hold to the beat exactly when that
 * quotient is already whole; otherwise each breath is off by up to half a
 * sample and the error accumulates from breath to breath.
 */
function breathing(samples: number, period: number): Float32Array {
  return new Float32Array(samples).map(
    (_zero, index) => 0.5 - 0.5 * cos((2 * Math.PI * (index % period)) / period)
  );
}

/**
 * A low, breath-like rumble of any length: pink noise and a low oscillator,
 * the noise its own in each channel, swelling and darkening with each breath.
 * No voice: filtered noise and a sine, nothing shaped like a vocal tract.
 */
export const rumble: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ beats, toneHz, breathRate }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const breath = breathing(samples, Math.round(frameToSample(framesPerBeat) / breathRate));
    const cutoff = breath.map((depth) => BREATH.closedHz + BREATH.openHz * depth);
    const tone = scaled(
      freeRunning(sine, { frequency: toneHz, samples, leadHz: toneHz }, rand),
      TONE_LEVEL
    );
    const level = multiply(
      breath.map((depth) => BREATH.floor + (1 - BREATH.floor) * depth),
      gate({ samples, attack: secondsToSamples(FADE), release: secondsToSamples(FADE) })
    );
    return anchoredAtStart(
      decorrelated(() =>
        multiply(
          add(
            svf(pinkNoise(samples, rand), { mode: 'lowpass', cutoff, resonance: BREATH.resonance }),
            tone
          ),
          level
        )
      )
    );
  },
});
