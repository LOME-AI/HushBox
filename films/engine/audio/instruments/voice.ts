import { exp2 } from '../../dmath/dmath.js';
import { SAMPLE_RATE, frameToSample } from '../../time/grid.js';
import { adsr, feedbackDelay, sampleAt } from '../dsp/index.js';

import type { Control, OscillatorOptions, StereoBuffer } from '../dsp/index.js';
import type { Rendered } from './instrument.js';

/** The tuning reference: MIDI note 69 is A4 at 440 Hz. */
const A4_NOTE = 69;
const A4_HZ = 440;
const SEMITONES_PER_OCTAVE = 12;

/** A MIDI note number's equal-tempered frequency in Hz; a fraction lies between semitones. */
export function midiToHz(note: number): number {
  return A4_HZ * exp2((note - A4_NOTE) / SEMITONES_PER_OCTAVE);
}

/** A musical length resolved at the film's tempo, refused unless it is a whole number of samples. */
export function beatsToSamples(beats: number, framesPerBeat: number): number {
  const samples = frameToSample(framesPerBeat) * beats;
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new RangeError(
      `${String(beats)} beats at framesPerBeat ${String(framesPerBeat)} is ${String(samples)} samples: a note needs a whole number of samples, at least one`
    );
  }
  return samples;
}

/** A physical length in seconds, to the nearest sample. */
export function secondsToSamples(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE);
}

/** Two equally long signals combined sample by sample. */
function combine(
  a: Float32Array,
  b: Float32Array,
  operation: (x: number, y: number) => number
): Float32Array {
  if (a.length !== b.length) {
    throw new RangeError(
      `signals of ${String(a.length)} and ${String(b.length)} samples cannot be combined: they must be equally long`
    );
  }
  return a.map((sample, index) => operation(sample, sampleAt(b, index)));
}

/** Two equally long signals multiplied sample by sample: a signal under an envelope. */
export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  return combine(a, b, (x, y) => x * y);
}

/** Two equally long signals summed sample by sample. */
export function add(a: Float32Array, b: Float32Array): Float32Array {
  return combine(a, b, (x, y) => x + y);
}

/** `height` on the first sample and silence after it. */
export function impulse(samples: number, height: number): Float32Array {
  const output = new Float32Array(samples);
  output[0] = height;
  return output;
}

interface FreeRunningOptions extends OscillatorOptions {
  /** The frequency the oscillator ran at before the note, over whose cycle its start phase is drawn. */
  leadHz: number;
}

/**
 * An oscillator that was already running when the note began, so it starts at a
 * phase drawn from `rand` rather than at 0: it is rendered from a drawn number
 * of samples (under one cycle of `leadHz`) earlier, and that lead is dropped.
 */
export function freeRunning(
  oscillator: (options: OscillatorOptions) => Float32Array,
  options: FreeRunningOptions,
  rand: () => number
): Float32Array {
  const { frequency, samples, leadHz } = options;
  const lead = Math.floor((rand() * SAMPLE_RATE) / leadHz);
  return oscillator({
    frequency: typeof frequency === 'number' ? frequency : prepend(frequency, leadHz, lead),
    samples: lead + samples,
  }).slice(lead);
}

/** The control preceded by `count` samples of `value`. */
function prepend(control: Float32Array, value: number, count: number): Control {
  const extended = new Float32Array(count + control.length).fill(value, 0, count);
  extended.set(control, count);
  return extended;
}

/** One signal in both channels, each with its own storage. */
export function mono(signal: Float32Array): StereoBuffer {
  return { left: signal, right: new Float32Array(signal) };
}

/** The loudest magnitude in either channel. */
function peakOf(buffer: StereoBuffer): number {
  let peak = 0;
  for (const channel of [buffer.left, buffer.right]) {
    for (const sample of channel) {
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  return peak;
}

/**
 * A sound whose cue lands on its first sample, scaled so its loudest sample sits
 * at full scale: an instrument's level is its track's to set, never its own. A
 * silent buffer stays silent.
 */
export function anchoredAtStart(buffer: StereoBuffer): Rendered {
  const peak = peakOf(buffer);
  if (peak === 0) {
    return { buffer, anchorOffset: 0 };
  }
  return {
    buffer: {
      left: buffer.left.map((sample) => sample / peak),
      right: buffer.right.map((sample) => sample / peak),
    },
    anchorOffset: 0,
  };
}

/**
 * A note's gate: a linear rise over `attack` samples, full level, then a linear
 * release ending with the note. When the attack and release together overrun
 * the note, both shrink by one factor to fill it exactly, with no hold, so the
 * note still reaches full level where its shortened attack ends: a short note
 * is never silent.
 */
export function gate(options: { samples: number; attack: number; release: number }): Float32Array {
  const { samples } = options;
  const span = options.attack + options.release;
  if (span <= samples) {
    return adsr({
      attack: options.attack,
      decay: 0,
      sustain: 1,
      hold: samples - options.release,
      release: options.release,
    });
  }
  const attack = Math.round((options.attack * samples) / span);
  return adsr({ attack, decay: 0, sustain: 1, hold: attack, release: samples - attack });
}

/** The largest magnitude among the values, rounded up to a whole sample. */
function reachOf(excursion: Float32Array): number {
  let reach = 0;
  for (const value of excursion) {
    reach = Math.max(reach, Math.abs(value));
  }
  return Math.ceil(reach);
}

/**
 * The input read `excursion[n]` samples late at each sample n, or early where the
 * excursion is negative, interpolating between samples: a delay swung about zero,
 * so the swing adds no latency. Whatever it reads beyond the input's ends is
 * silence. A swept delay shifts pitch by Doppler, which is how the rotary speaker
 * and phase modulation are made from the delay line.
 */
export function swing(input: Float32Array, excursion: Float32Array): Float32Array {
  if (excursion.length !== input.length) {
    throw new RangeError(
      `excursion holds ${String(excursion.length)} values for ${String(input.length)} samples: it needs one value per sample`
    );
  }
  // Every read is `offset` samples later than asked, so an excursion of −reach
  // still asks the delay line for at least one sample, the least it can give.
  const offset = 1 + reachOf(excursion);
  const padded = new Float32Array(input.length + offset);
  padded.set(input);
  const time = new Float32Array(padded.length).fill(offset);
  time.set(
    excursion.map((value) => offset + value),
    offset
  );
  return feedbackDelay(padded, { time, feedback: 0 }).slice(offset);
}
