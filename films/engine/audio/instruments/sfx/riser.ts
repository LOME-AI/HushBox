import { z } from 'zod';

import { defineInstrument } from '../instrument.js';
import { beatsSchema } from '../note-params.js';
import { add, beatsToSamples, multiply } from '../voice.js';

import { anchoredAtEnd, reversed } from './anchor.js';
import { scaled } from './layer.js';
import { fallingSweep, shepardFall } from './sweep.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  beats: beatsSchema(4),
  /** How far the tone and the Shepard layer climb, in octaves. */
  octaves: z.number().min(1).max(3).default(2),
});

const SHEPARD_LEVEL = 0.3;

/** The swell's level at every sample of the time-reversed render: the cube of the time left. */
function fadeOut(samples: number): Float32Array {
  return new Float32Array(samples).map((_zero, index) => {
    const left = 1 - index / samples;
    return left * left * left;
  });
}

/**
 * A riser: noise whose band-pass sweeps up from 200 Hz to 12 kHz, a tone and a
 * Shepard–Risset layer climbing, all swelling to a hard stop on the cue. It is
 * rendered as its own time-reverse, a sweep falling from a strike, then played
 * backwards, so its last sample carries the strike and is heard whatever the
 * seed: the riser sounds right up to its cue.
 */
export const riser: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ beats, octaves }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const fade = fadeOut(samples);
    const sweep = fallingSweep({ envelope: fade, octaves, mode: 'bandpass' }, rand);
    const shepard = scaled(multiply(shepardFall(samples, octaves), fade), SHEPARD_LEVEL);
    return anchoredAtEnd(
      reversed({ left: add(sweep.left, shepard), right: add(sweep.right, shepard) })
    );
  },
});
