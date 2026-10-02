import { z } from 'zod';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { exponentialDecay } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { beatsSchema } from '../note-params.js';
import { anchoredAtStart, beatsToSamples } from '../voice.js';

import { fallingSweep } from './sweep.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  beats: beatsSchema(2),
  /** How far the tone falls, in octaves. */
  octaves: z.number().min(1).max(3).default(2),
});

/**
 * A downlifter: struck noise whose low-pass falls from 12 kHz to 200 Hz over a
 * falling tone, the whole falling 60 dB by its last sample.
 */
export const downlifter: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ beats, octaves }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const envelope = exponentialDecay({ samples, t60: samples / SAMPLE_RATE });
    return anchoredAtStart(fallingSweep({ envelope, octaves, mode: 'lowpass' }, rand));
  },
});
