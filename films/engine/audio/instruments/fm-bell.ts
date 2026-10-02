import { z } from 'zod';

import { SAMPLE_RATE } from '../../time/grid.js';
import { exponentialDecay, sine } from '../dsp/index.js';

import { defineInstrument } from './instrument.js';
import { noteSchema } from './note-params.js';
import {
  anchoredAtStart,
  freeRunning,
  midiToHz,
  mono,
  multiply,
  secondsToSamples,
  swing,
} from './voice.js';

import type { Instrument } from './instrument.js';

const params = z.object({
  note: noteSchema(48, 84).default(72),
  /** Seconds for the tone to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.1).max(8).default(2.5),
});

/**
 * Chowning's bell: a modulator at 1.4 times the carrier, inharmonic against it,
 * whose index starts at 6 for a bright strike and dies three times faster than
 * the tone, leaving it pure.
 */
const RATIO = 1.4;
const INDEX = 6;
const INDEX_SHARE = 1 / 3;

/**
 * An FM bell. The phase modulation is a read of the carrier swung early and
 * late: a carrier read `e` samples late lags `2π·f·e / SAMPLE_RATE` radians, so
 * a phase deviation φ is an excursion of `−φ·SAMPLE_RATE / (2π·f)` samples.
 * The carrier starts `reach` samples early, so the earliest read still finds it
 * sounding.
 */
export const fmBell: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ note, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const carrierHz = midiToHz(note);
    const modulatorHz = carrierHz * RATIO;
    const samplesPerRadian = SAMPLE_RATE / (2 * Math.PI * carrierHz);
    const reach = Math.ceil(INDEX * samplesPerRadian);
    const index = exponentialDecay({ samples, t60: decay * INDEX_SHARE });
    const modulator = freeRunning(
      sine,
      { frequency: modulatorHz, samples, leadHz: modulatorHz },
      rand
    );
    const excursion = new Float32Array(reach + samples);
    excursion.set(
      multiply(index, modulator).map((deviation) => -deviation * INDEX * samplesPerRadian),
      reach
    );
    const carrier = freeRunning(
      sine,
      { frequency: carrierHz, samples: reach + samples, leadHz: carrierHz },
      rand
    );
    const tone = swing(carrier, excursion).slice(reach);
    return anchoredAtStart(mono(multiply(tone, exponentialDecay({ samples, t60: decay }))));
  },
});
