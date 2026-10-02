import { z } from 'zod';

import { SAMPLE_RATE } from '../../time/grid.js';
import { exponentialDecay } from '../dsp/index.js';

import { excite } from './drum.js';
import { defineInstrument } from './instrument.js';
import { add, anchoredAtStart, mono, secondsToSamples } from './voice.js';

import type { SvfOptions } from '../dsp/index.js';
import type { Instrument } from './instrument.js';

const params = z.object({
  /** Hz the noise is band-passed around. */
  toneHz: z.number().min(500).max(4000).default(1200),
  /** Seconds from the first hand to the end of the tail, which falls 60 dB by then. */
  decay: z.number().min(0.05).max(2).default(0.35),
});

/** Seconds from the first hand to the last, where the tail begins. */
const LAST_HAND = 0.022;
/** Seconds from the first hand to each hand: several hands, a few milliseconds apart. */
const HANDS = [0, 0.011, LAST_HAND] as const;
/** Seconds for each hand's burst to fall 60 dB. */
const HAND_T60 = 0.03;
/** The room's tail, from the last hand on. */
const TAIL_LEVEL = 0.5;
const RESONANCE = 0.4;

/** `signal` moved `by` samples later, keeping its length. */
function delayed(signal: Float32Array, by: number): Float32Array {
  const output = new Float32Array(signal.length);
  output.set(signal.subarray(0, signal.length - by), by);
  return output;
}

/** A burst per hand, then a tail from the last hand that falls 60 dB by the last sample. */
function clapEnvelope(samples: number): Float32Array {
  let envelope: Float32Array = new Float32Array(samples);
  for (const seconds of HANDS) {
    const burst = exponentialDecay({ samples, t60: HAND_T60 });
    envelope = add(envelope, delayed(burst, secondsToSamples(seconds)));
  }
  const tailStart = secondsToSamples(LAST_HAND);
  const tailLength = samples - tailStart;
  const tail = exponentialDecay({ samples: tailLength, t60: tailLength / SAMPLE_RATE });
  const placed = new Float32Array(samples);
  placed.set(
    tail.map((level) => level * TAIL_LEVEL),
    tailStart
  );
  return add(envelope, placed);
}

/** A hand clap: several hands' noise bursts in quick succession and a short tail, band-passed. */
export const clap: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const envelope = clapEnvelope(secondsToSamples(decay));
    const filter: SvfOptions = { mode: 'bandpass', cutoff: toneHz, resonance: RESONANCE };
    return anchoredAtStart(mono(excite({ envelope, filter }, rand)));
  },
});
