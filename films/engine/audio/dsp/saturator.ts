import { cos, sin, tanh } from '../../dmath/dmath.js';

import { POSITIVE_FINITE, requireInRange } from './bounds.js';
import { sampleAt } from './buffer.js';

const OVERSAMPLING = 4;
/**
 * An even length, so no tap sits at the sinc's centre, and at 4× this long the
 * kernel is flat to 20 kHz and 68 dB down by 28 kHz, where the first image of
 * 20 kHz content begins.
 */
const TAPS = 128;

/**
 * A Blackman-windowed sinc low-pass at the base rate's Nyquist, designed at the
 * oversampled rate and normalised to unity gain at DC. It serves as both the
 * interpolator and the decimator.
 */
function designKernel(): Float64Array {
  const kernel = new Float64Array(TAPS);
  const centre = (TAPS - 1) / 2;
  const cutoff = 0.5 / OVERSAMPLING;
  let sum = 0;
  for (let tap = 0; tap < TAPS; tap++) {
    const offset = tap - centre;
    const ideal = sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
    const turn = (2 * Math.PI * tap) / (TAPS - 1);
    const window = 0.42 - 0.5 * cos(turn) + 0.08 * cos(2 * turn);
    kernel[tap] = ideal * window;
    sum += ideal * window;
  }
  return kernel.map((coefficient) => coefficient / sum);
}

const KERNEL = designKernel();

/** The input at 4× the rate: zeros stuffed between samples, then interpolated (gain 4 restores the level). */
function interpolate(input: Float32Array): Float64Array {
  const upsampled = new Float64Array(input.length * OVERSAMPLING + TAPS - 1);
  for (let position = 0; position < upsampled.length; position++) {
    let sum = 0;
    for (let tap = position % OVERSAMPLING; tap < TAPS; tap += OVERSAMPLING) {
      const source = (position - tap) / OVERSAMPLING;
      if (source >= 0 && source < input.length) {
        sum += sampleAt(KERNEL, tap) * sampleAt(input, source);
      }
    }
    upsampled[position] = OVERSAMPLING * sum;
  }
  return upsampled;
}

/**
 * Low-passes and keeps every fourth sample. The two kernels together delay the
 * signal by TAPS − 1 oversampled samples, so output sample i is read there and
 * lands on input sample i.
 */
function decimate(oversampled: Float64Array, length: number): Float32Array {
  const output = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const newest = index * OVERSAMPLING + TAPS - 1;
    let sum = 0;
    for (let tap = 0; tap < TAPS; tap++) {
      sum += sampleAt(KERNEL, tap) * sampleAt(oversampled, newest - tap);
    }
    output[index] = sum;
  }
  return output;
}

/**
 * tanh(drive · x), run at four times the sample rate so the harmonics it
 * creates between 24 and 72 kHz are filtered before they can fold back into the
 * audio band. The output is as long as the input and aligned with it.
 */
export function saturate(input: Float32Array, drive: number): Float32Array {
  requireInRange('drive', drive, POSITIVE_FINITE);
  const oversampled = interpolate(input).map((sample) => tanh(drive * sample));
  return decimate(oversampled, input.length);
}
