import { z } from 'zod';

import { pinkNoise, svf } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { anchoredAtStart, beatsToSamples, gate, secondsToSamples } from '../voice.js';

import { bedBeatsSchema } from './bed.js';
import { decorrelated, underEnvelope } from './layer.js';

import type { SvfOptions } from '../../dsp/index.js';
import type { Instrument } from '../instrument.js';

const params = z.object({
  beats: bedBeatsSchema(4),
  /** Hz of the low-pass that keeps the room's air low. */
  cutoff: z.number().min(60).max(2000).default(240),
});

/** Seconds the bed takes to rise from silence and to fall back to it. */
const FADE = 0.3;
const RESONANCE = 0.1;
/** Below the room's air: removed so the bed spends no headroom on what no speaker plays. */
const SUBSONIC: SvfOptions = { mode: 'highpass', cutoff: 30, resonance: 0 };

/** A room's tone: low-passed pink noise, its own in each channel, faded in and out, of any length. */
export const roomTone: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ beats, cutoff }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const air = (): Float32Array =>
      svf(
        svf(pinkNoise(samples, rand), { mode: 'lowpass', cutoff, resonance: RESONANCE }),
        SUBSONIC
      );
    const fade = gate({
      samples,
      attack: secondsToSamples(FADE),
      release: secondsToSamples(FADE),
    });
    return anchoredAtStart(underEnvelope(decorrelated(air), fade));
  },
});
