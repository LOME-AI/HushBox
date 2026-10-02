import { z } from 'zod';

import { pow } from '../../dmath/dmath.js';
import { sine } from '../dsp/index.js';

import { defineInstrument } from './instrument.js';
import { beatsSchema, chordSchema } from './note-params.js';
import {
  add,
  anchoredAtStart,
  beatsToSamples,
  freeRunning,
  gate,
  midiToHz,
  multiply,
  secondsToSamples,
  swing,
} from './voice.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  notes: chordSchema(24, 96, [60, 64, 67]),
  beats: beatsSchema(4),
  /** The registration, as an organist writes it: nine drawbars from 16' to 1', each 0 (in) to 8 (out). */
  drawbars: z
    .string()
    .regex(/^[0-8]{9}$/, 'must be nine drawbar settings, each 0 to 8')
    .default('888000000'),
  /** Turns per second of the rotary speaker: near 0.8 for chorale, near 6.7 for tremolo. */
  rotorHz: z.number().min(0.1).max(10).default(0.8),
});

/** Each drawbar's pitch against the note, 16' to 1'. */
const DRAWBAR_RATIOS = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8] as const;
const DRAWBAR_OUT = 8;
const DB_PER_STEP = 3;
const ATTACK = 0.005;
const RELEASE = 0.03;
/** The horn's swing: a delay of up to 16 samples (0.33 ms) each way, and a quarter of its level. */
const DOPPLER = 16;
const TREMOLO = 0.25;

/** A drawbar's gain: 3 dB per step below fully out, and nothing at all when pushed in. */
function drawbarGain(step: number): number {
  return Math.sign(step) * pow(10, (DB_PER_STEP * (step - DRAWBAR_OUT)) / 20);
}

/**
 * The rotary speaker: as the horn turns, it nears one microphone while leaving
 * the other, so each channel's pitch (by Doppler) and level swing in opposition.
 */
function rotary(dry: Float32Array, rotorHz: number, rand: () => number): StereoBuffer {
  const rotor = freeRunning(
    sine,
    { frequency: rotorHz, samples: dry.length, leadHz: rotorHz },
    rand
  );
  const side = (direction: number): Float32Array =>
    multiply(
      swing(
        dry,
        rotor.map((turn) => direction * DOPPLER * turn)
      ),
      rotor.map((turn) => 1 + direction * TREMOLO * turn)
    );
  return { left: side(1), right: side(-1) };
}

/** A tonewheel organ: sine partials at the drawbars' pitches, through a rotary speaker. */
export const organ: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ notes, beats, drawbars, rotorHz }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    let tone: Float32Array = new Float32Array(samples);
    for (const note of notes) {
      for (const [index, ratio] of DRAWBAR_RATIOS.entries()) {
        const gain = drawbarGain(Number(drawbars.charAt(index)));
        const hertz = midiToHz(note) * ratio;
        const wheel = freeRunning(sine, { frequency: hertz, samples, leadHz: hertz }, rand);
        tone = add(
          tone,
          wheel.map((sample) => sample * gain)
        );
      }
    }
    const envelope = gate({
      samples,
      attack: secondsToSamples(ATTACK),
      release: secondsToSamples(RELEASE),
    });
    return anchoredAtStart(rotary(multiply(tone, envelope), rotorHz, rand));
  },
});
