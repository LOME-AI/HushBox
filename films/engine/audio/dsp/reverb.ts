import { exp } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';

import { AUDIO_FREQUENCY, POSITIVE_FINITE, requireInRange } from './bounds.js';
import { createStereo, requireEqualChannels, sampleAt } from './buffer.js';
import { createDelayLine } from './delay.js';
import { LN_1000 } from './envelopes.js';
import { createOnePole } from './one-pole.js';

import type { StereoBuffer } from './buffer.js';

export interface ReverbOptions {
  /** Seconds for the tail to fall 60 dB, below the damping cutoff. */
  rt60: number;
  /** Hz, in [0, SAMPLE_RATE / 2): the corner of the low-pass in every loop, so highs die sooner. */
  damping: number;
}

/**
 * The eight line lengths in samples, 23 to 69 ms: primes, so two lines' echoes
 * coincide only at multiples of the product of their lengths.
 */
const LINE_LENGTHS = [1123, 1321, 1553, 1811, 2111, 2459, 2861, 3323] as const;
const LINES = LINE_LENGTHS.length;
/** Four lines feed each output channel; halving keeps their uncorrelated sum near one line's level. */
const OUTPUT_GAIN = 0.5;
const HADAMARD_SCALE = 1 / Math.sqrt(LINES);

/** The orthonormal 8×8 Hadamard mix, in place: every line feeds every line, energy preserved. */
function hadamard(values: Float64Array): void {
  for (let span = 1; span < LINES; span *= 2) {
    for (let start = 0; start < LINES; start += 2 * span) {
      for (let index = start; index < start + span; index++) {
        const a = sampleAt(values, index);
        const b = sampleAt(values, index + span);
        values[index] = a + b;
        values[index + span] = a - b;
      }
    }
  }
  for (let index = 0; index < LINES; index++) {
    values[index] = sampleAt(values, index) * HADAMARD_SCALE;
  }
}

/** The sum of every other line's output, starting at line `first`. */
function sumOfEvery(outs: Float64Array, first: number): number {
  let sum = 0;
  for (let line = first; line < LINES; line += 2) {
    sum += sampleAt(outs, line);
  }
  return sum;
}

/**
 * An eight-line feedback delay network: the wet signal alone. Lines 0–3 take
 * the left input and 4–7 the right; even lines feed the left output and odd
 * lines the right. Each line's loop gain, 10^(−3·length / (rt60·SAMPLE_RATE)),
 * takes 60 dB off every rt60 seconds; the output is as long as the input, so
 * pad the input with silence to keep the tail.
 */
export function fdnReverb(input: StereoBuffer, options: ReverbOptions): StereoBuffer {
  requireEqualChannels(input);
  const rt60 = requireInRange('rt60', options.rt60, POSITIVE_FINITE);
  const damping = requireInRange('damping', options.damping, AUDIO_FREQUENCY);
  const lines = LINE_LENGTHS.map((length) => ({
    length,
    delay: createDelayLine(length),
    gain: exp(-(LN_1000 * length) / (rt60 * SAMPLE_RATE)),
    damp: createOnePole({ mode: 'lowpass', cutoff: damping }),
  }));
  const output = createStereo(input.left.length);
  const outs = new Float64Array(LINES);
  for (const [index, left] of input.left.entries()) {
    const right = sampleAt(input.right, index);
    for (const [line, { delay, length }] of lines.entries()) {
      outs[line] = delay.tap(length - 1);
    }
    output.left[index] = sumOfEvery(outs, 0) * OUTPUT_GAIN;
    output.right[index] = sumOfEvery(outs, 1) * OUTPUT_GAIN;
    hadamard(outs);
    for (const [line, { delay, gain, damp }] of lines.entries()) {
      delay.write(damp(gain * sampleAt(outs, line)) + (line < LINES / 2 ? left : right));
    }
  }
  return output;
}
