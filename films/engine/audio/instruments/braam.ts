import { z } from 'zod';

import { exp2 } from '../../dmath/dmath.js';
import {
  createStereo,
  exponentialDecay,
  exponentialRamp,
  mixInto,
  saturate,
  saw,
  square,
  svf,
} from '../dsp/index.js';

import { defineInstrument } from './instrument.js';
import { beatsSchema, noteSchema } from './note-params.js';
import {
  anchoredAtStart,
  beatsToSamples,
  freeRunning,
  gate,
  midiToHz,
  multiply,
  secondsToSamples,
} from './voice.js';

import type { OscillatorOptions } from '../dsp/index.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  /** The fundamental, C1 to C3; C1 to C2 is the classic range. */
  note: noteSchema(24, 48).default(29),
  beats: beatsSchema(8),
});

/** Detuned saws across the field, a square an octave down, and a quiet tritone for unease. */
const LAYERS = [
  { semitones: -0.14, pan: -0.8, level: 0.2, oscillator: saw },
  { semitones: -0.06, pan: -0.4, level: 0.2, oscillator: saw },
  { semitones: 0, pan: 0, level: 0.2, oscillator: saw },
  { semitones: 0.05, pan: 0.4, level: 0.2, oscillator: saw },
  { semitones: 0.13, pan: 0.8, level: 0.2, oscillator: saw },
  { semitones: -12, pan: 0, level: 0.3, oscillator: square },
  { semitones: 6, pan: 0, level: 0.05, oscillator: saw },
] as const;
/** The brass blat: the low-pass opens from 200 Hz to 3 kHz in 0.1 s, then closes to 600 Hz over 2 s. */
const BLAT = { from: 200, open: 3000, closed: 600, opening: 0.1, closing: 2 } as const;
const RESONANCE = 0.35;
/** Saturation after the filter, so the grit grows as the filter opens. */
const DRIVE = 3;
/** The pitch sags 70 cents, nearly all of it in the first 2 s. */
const SAG_CENTS = -70;
const SAG_T60 = 3;
const CENTS_PER_OCTAVE = 1200;
const ATTACK = 0.015;
const RELEASE = 0.4;

/** The filter's cutoff at every sample: the blat, then held closed. */
function blat(samples: number): Float32Array {
  const rise = exponentialRamp({
    from: BLAT.from,
    to: BLAT.open,
    samples: secondsToSamples(BLAT.opening),
  });
  const fall = exponentialRamp({
    from: BLAT.open,
    to: BLAT.closed,
    samples: secondsToSamples(BLAT.closing),
  });
  const cutoff = new Float32Array(samples).fill(BLAT.closed);
  cutoff.set(rise.subarray(0, samples));
  cutoff.set(fall.subarray(0, Math.max(0, samples - rise.length)), Math.min(rise.length, samples));
  return cutoff;
}

/** A trailer braam: a stack of detuned saws and a sub square, blatting through a low-pass into saturation. */
export const braam: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ note, beats }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const sag = exponentialDecay({ samples, t60: SAG_T60 }).map((remaining) =>
      exp2((SAG_CENTS * (1 - remaining)) / CENTS_PER_OCTAVE)
    );
    const voices = createStereo(samples);
    for (const layer of LAYERS) {
      const hertz = midiToHz(note + layer.semitones);
      const options: OscillatorOptions = { frequency: sag.map((ratio) => hertz * ratio), samples };
      const tone = freeRunning(layer.oscillator, { ...options, leadHz: hertz }, rand);
      mixInto(voices, tone, { atSample: 0, gain: layer.level, pan: layer.pan });
    }
    const cutoff = blat(samples);
    const shape = gate({
      samples,
      attack: secondsToSamples(ATTACK),
      release: secondsToSamples(RELEASE),
    });
    const channel = (signal: Float32Array): Float32Array =>
      multiply(
        saturate(svf(signal, { mode: 'lowpass', cutoff, resonance: RESONANCE }), DRIVE),
        shape
      );
    return anchoredAtStart({ left: channel(voices.left), right: channel(voices.right) });
  },
});
