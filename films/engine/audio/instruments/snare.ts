import { z } from 'zod';

import { exponentialDecay, saturate } from '../dsp/index.js';

import { excite, membrane } from './drum.js';
import { defineInstrument } from './instrument.js';
import { add, anchoredAtStart, mono, secondsToSamples } from './voice.js';

import type { SvfOptions } from '../dsp/index.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  /** Hz of the shell's lower mode; the upper sits at `UPPER_MODE` times it. */
  toneHz: z.number().min(100).max(500).default(190),
  /** Seconds for the wires to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.05).max(2).default(0.35),
});

/** The shell's two modes, near 190 and 330 Hz on a tuned snare. */
const UPPER_MODE = 1.74;
const UPPER_LEVEL = 0.6;
/** Each mode starts a quarter sharp and settles within a few milliseconds. */
const SWEEP = 1.25;
const SWEEP_T60 = 0.03;
/** The shell rings for this share of the wires' decay. */
const BODY_SHARE = 0.4;
const BODY_LEVEL = 0.35;
/** The wires: noise band-passed wide around 2.7 kHz, from 1.5 to 5 kHz. */
const WIRES: SvfOptions = { mode: 'bandpass', cutoff: 2700, resonance: 0 };
const DRIVE = 1.5;

/** A snare drum: two shell modes under louder noise wires, saturated together. */
export const snare: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const mode = (hertz: number, level: number): Float32Array =>
      membrane({
        samples,
        startHz: hertz * SWEEP,
        endHz: hertz,
        pitchT60: SWEEP_T60,
        t60: decay * BODY_SHARE,
      }).map((sample) => sample * level * BODY_LEVEL);
    const body = add(mode(toneHz, 1), mode(toneHz * UPPER_MODE, UPPER_LEVEL));
    const wires = excite(
      { envelope: exponentialDecay({ samples, t60: decay }), filter: WIRES },
      rand
    );
    return anchoredAtStart(mono(saturate(add(body, wires), DRIVE)));
  },
});
