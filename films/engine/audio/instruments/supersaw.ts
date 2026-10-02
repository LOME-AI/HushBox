import { z } from 'zod';

import { createStereo, mixInto, saw, svf } from '../dsp/index.js';

import { defineInstrument } from './instrument.js';
import { beatsSchema, chordSchema } from './note-params.js';
import {
  anchoredAtStart,
  beatsToSamples,
  freeRunning,
  gate,
  midiToHz,
  multiply,
  secondsToSamples,
} from './voice.js';

import type { StereoBuffer, SvfOptions } from '../dsp/index.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  notes: chordSchema(24, 108, [60, 64, 67]),
  beats: beatsSchema(1),
  /** How far the six outer voices spread from the note: 1 is the JP-8000's widest. */
  detune: z.number().min(0).max(1).default(0.35),
});

/**
 * The JP-8000's seven voices as Szabo measured them: each voice's frequency
 * offset as a fraction of the note at full detune, its place across the field,
 * and its level, the centre voice louder than the six around it.
 */
const VOICES = [
  { offset: -0.110_023_13, pan: -0.8, level: 0.5 },
  { offset: -0.062_884_39, pan: -0.533, level: 0.5 },
  { offset: -0.019_523_56, pan: -0.267, level: 0.5 },
  { offset: 0, pan: 0, level: 0.72 },
  { offset: 0.019_912_21, pan: 0.267, level: 0.5 },
  { offset: 0.062_165_38, pan: 0.533, level: 0.5 },
  { offset: 0.107_452_42, pan: 0.8, level: 0.5 },
] as const;
const ATTACK = 0.003;
const RELEASE = 0.04;

/** One note's seven free-running saws, high-passed at the note as the JP-8000 does. */
function stack(hertz: number, detune: number, samples: number, rand: () => number): StereoBuffer {
  const voices = createStereo(samples);
  for (const { offset, pan, level } of VOICES) {
    const frequency = hertz * (1 + detune * offset);
    const tone = freeRunning(saw, { frequency, samples, leadHz: frequency }, rand);
    mixInto(voices, tone, { atSample: 0, gain: level, pan });
  }
  const highPass: SvfOptions = { mode: 'highpass', cutoff: hertz, resonance: 0 };
  return { left: svf(voices.left, highPass), right: svf(voices.right, highPass) };
}

/** A supersaw chord: seven detuned saws per note, spread across the field. */
export const supersaw: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ notes, beats, detune }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const chord = createStereo(samples);
    for (const note of notes) {
      mixInto(chord, stack(midiToHz(note), detune, samples, rand), {
        atSample: 0,
        gain: 1,
        pan: 0,
      });
    }
    const shape = gate({
      samples,
      attack: secondsToSamples(ATTACK),
      release: secondsToSamples(RELEASE),
    });
    return anchoredAtStart({
      left: multiply(chord.left, shape),
      right: multiply(chord.right, shape),
    });
  },
});
