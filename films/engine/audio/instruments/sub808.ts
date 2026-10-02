import { z } from 'zod';

import { exponentialDecay, saturate, sine } from '../dsp/index.js';

import { defineInstrument } from './instrument.js';
import { beatsSchema, noteSchema } from './note-params.js';
import {
  anchoredAtStart,
  beatsToSamples,
  freeRunning,
  gate,
  midiToHz,
  mono,
  multiply,
  secondsToSamples,
} from './voice.js';

import type { Instrument } from './instrument.js';

const params = z.object({
  note: noteSchema(12, 60).default(33),
  beats: beatsSchema(2),
  /** The note it slides from, when it slides. */
  glideFrom: noteSchema(12, 60).optional(),
  /** Seconds for the slide to cover all but a thousandth of its interval, in semitones. */
  glide: z.number().min(0.005).max(2).default(0.25),
  /** Seconds for the level to fall 60 dB while the note holds. */
  decay: z.number().min(0.05).max(10).default(3),
  /** The saturator's drive: its harmonics carry the note on speakers too small for the fundamental. */
  drive: z.number().min(0.5).max(8).default(1.5),
});

/** Seconds of the linear rise and fall at the note's ends, so it neither clicks on nor off. */
const ATTACK = 0.003;
const RELEASE = 0.01;

/** An 808 bass: a sine at the note, gliding in semitones when it slides, decaying, saturated. */
export const sub808: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ note, beats, glideFrom, glide, decay, drive }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const from = glideFrom ?? note;
    const frequency = exponentialDecay({ samples, t60: glide }).map((remaining) =>
      midiToHz(note + (from - note) * remaining)
    );
    const tone = freeRunning(sine, { frequency, samples, leadHz: midiToHz(from) }, rand);
    const envelope = multiply(
      exponentialDecay({ samples, t60: decay }),
      gate({ samples, attack: secondsToSamples(ATTACK), release: secondsToSamples(RELEASE) })
    );
    return anchoredAtStart(mono(saturate(multiply(tone, envelope), drive)));
  },
});
