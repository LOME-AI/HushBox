import { z } from 'zod';

import { exponentialDecay, square, svf } from '../dsp/index.js';

import { excite } from './drum.js';
import { defineInstrument } from './instrument.js';
import {
  add,
  anchoredAtStart,
  freeRunning,
  gate,
  mono,
  multiply,
  secondsToSamples,
} from './voice.js';

import type { SvfOptions } from '../dsp/index.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  variant: z.enum(['closed', 'open']).default('closed'),
});

/** Seconds for each variant to fall 60 dB, which is also its length. */
const T60 = { closed: 0.08, open: 0.6 } as const;

/**
 * The TR-808's six square oscillators, inharmonic against each other, whose sum
 * band-passed high is the metal (Werner, Abel and Smith, ICMC 2014).
 */
const METAL_HZ = [205.3, 304.4, 369.6, 522.7, 540, 800] as const;
const METAL_BAND: SvfOptions = { mode: 'bandpass', cutoff: 8500, resonance: 0.3 };
const HIGH_PASS: SvfOptions = { mode: 'highpass', cutoff: 7500, resonance: 0 };
/**
 * Seconds for the metal to rise from silence. Its first sample is therefore 0,
 * so the stick alone decides it: a sum of free-running squares can land on any
 * value there, and could cancel the stick for some seed.
 */
const METAL_ATTACK = 0.0005;
/** The stick's tick: a burst of a few milliseconds through the same high-pass. */
const STICK_T60 = 0.01;
const STICK_LEVEL = 0.1;

/** A hi-hat: six free-running squares band-passed into metal, a stick tick, and a decay. */
export const hat: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ variant }, { rand }) {
    const t60 = T60[variant];
    const samples = secondsToSamples(t60);
    let oscillators: Float32Array = new Float32Array(samples);
    for (const hertz of METAL_HZ) {
      const voice = freeRunning(square, { frequency: hertz, samples, leadHz: hertz }, rand);
      oscillators = add(oscillators, voice);
    }
    const metal = multiply(
      svf(svf(oscillators, METAL_BAND), HIGH_PASS),
      gate({ samples, attack: secondsToSamples(METAL_ATTACK), release: 0 })
    );
    const stick = excite(
      { envelope: exponentialDecay({ samples, t60: STICK_T60 }), filter: HIGH_PASS },
      rand
    ).map((sample) => sample * STICK_LEVEL);
    return anchoredAtStart(mono(multiply(add(metal, stick), exponentialDecay({ samples, t60 }))));
  },
});
