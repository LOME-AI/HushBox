import { z } from 'zod';

import { FPS, SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, exponentialRamp, mixInto, saw, sine, svf } from '../dsp/index.js';

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

import type { Instrument } from './instrument.js';

const params = z.object({
  notes: chordSchema(24, 108, [57, 60, 64]),
  beats: beatsSchema(8),
  /** Seconds to swell in. */
  attack: z.number().min(0).max(10).default(0.8),
  /** Seconds to fade out, ending with the note. */
  release: z.number().min(0).max(10).default(1.2),
  /** How far the tremolo dips the level between its crests: 0 not at all, 1 to silence. */
  tremolo: z.number().min(0).max(1).default(0),
  /** Tremolo cycles per beat, a crest on every beat's start when whole. */
  tremoloRate: z.number().min(0.25).max(16).default(4),
});

/** Each note's unison voices: a detune in cents and a place in the field. */
const VOICES = [
  { cents: -12, pan: -0.6 },
  { cents: 0, pan: 0 },
  { cents: 12, pan: 0.6 },
] as const;
const CENTS_PER_SEMITONE = 100;
/** The low-pass opens over the whole note, from dark to warm. */
const CUTOFF_FROM = 600;
const CUTOFF_TO = 3200;
const RESONANCE = 0.2;

/** The tremolo's gain, locked to the beat: its crest falls on the note's first sample. */
function tremoloGain(options: {
  samples: number;
  depth: number;
  cyclesPerBeat: number;
  framesPerBeat: number;
}): Float32Array {
  const { samples, depth } = options;
  const hertz = (options.cyclesPerBeat * FPS) / options.framesPerBeat;
  // A sine started a quarter cycle early is at its crest on the first sample kept.
  const lead = Math.round(SAMPLE_RATE / (4 * hertz));
  const lfo = sine({ frequency: hertz, samples: lead + samples }).slice(lead);
  return lfo.map((value) => 1 - (depth * (1 - value)) / 2);
}

/** A pad: detuned unison saws per note, spread wide, under a slowly opening low-pass, a swell and a beat-locked tremolo. */
export const pad: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ notes, beats, attack, release, tremolo, tremoloRate }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const voices = createStereo(samples);
    for (const note of notes) {
      for (const voice of VOICES) {
        const hertz = midiToHz(note + voice.cents / CENTS_PER_SEMITONE);
        const tone = freeRunning(saw, { frequency: hertz, samples, leadHz: hertz }, rand);
        mixInto(voices, tone, { atSample: 0, gain: 1, pan: voice.pan });
      }
    }
    const cutoff = exponentialRamp({ from: CUTOFF_FROM, to: CUTOFF_TO, samples });
    const shape = multiply(
      gate({ samples, attack: secondsToSamples(attack), release: secondsToSamples(release) }),
      tremoloGain({ samples, depth: tremolo, cyclesPerBeat: tremoloRate, framesPerBeat })
    );
    const channel = (signal: Float32Array): Float32Array =>
      multiply(svf(signal, { mode: 'lowpass', cutoff, resonance: RESONANCE }), shape);
    return anchoredAtStart({ left: channel(voices.left), right: channel(voices.right) });
  },
});
