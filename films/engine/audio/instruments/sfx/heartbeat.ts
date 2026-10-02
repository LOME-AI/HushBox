import { z } from 'zod';

import { saturate } from '../../dsp/index.js';
import { membrane } from '../drum.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, mono, secondsToSamples } from '../voice.js';

import { burst } from './burst.js';
import { placedAt, scaled } from './layer.js';

import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';

const params = z.object({
  /** Hz each beat's thud settles on. */
  toneHz: z.number().min(30).max(120).default(55),
  /** Seconds from the first beat to the second. */
  gap: z.number().min(0.08).max(0.5).default(0.2),
  /** Seconds for each beat to fall 60 dB, which is also its length. */
  decay: z.number().min(0.08).max(0.6).default(0.22),
});

/** The second beat, a little higher and softer than the first. */
const SECOND = { pitch: 1.12, level: 0.7 };
/** Each beat's pitch starts this far above its tone and settles within 50 ms. */
const SWEEP = 1.6;
const PITCH_T60 = 0.05;
/** The beat's impact against the chest wall: a short band-passed burst. */
const THUMP: Burst = {
  t60: 0.02,
  filter: { mode: 'bandpass', cutoff: 700, resonance: 0.2 },
  level: 0.3,
};
/** Saturation adds the harmonics that carry a beat this low on small speakers. */
const DRIVE = 2.5;

/** A heartbeat: two low thuds, the second a gap after the first, saturated together. */
export const heartbeat: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, gap, decay }, { rand }) {
    const second = secondsToSamples(gap);
    const beatSamples = secondsToSamples(decay);
    const samples = second + beatSamples;
    const beat = (hertz: number, level: number, at: number): Float32Array => {
      const thud = membrane({
        samples: beatSamples,
        startHz: hertz * SWEEP,
        endHz: hertz,
        pitchT60: PITCH_T60,
        t60: decay,
      });
      return placedAt(scaled(add(thud, burst(beatSamples, THUMP, rand)), level), at, samples);
    };
    const body = add(beat(toneHz, 1, 0), beat(toneHz * SECOND.pitch, SECOND.level, second));
    return anchoredAtStart(mono(saturate(body, DRIVE)));
  },
});
