import { cos, sin } from '../dmath/dmath.js';

import { amplitudeToDb } from './decibels.js';
import { requireStereo, sampleAt } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Interpolated points per input sample. */
const OVERSAMPLING = 4;

/** Input samples on each side of an interpolated point that its filter reads. */
const HALF_TAPS = 16;

/** The four-term Blackman–Harris window's cosine weights. */
const WINDOW_WEIGHTS = [0.358_75, 0.488_29, 0.141_28, 0.011_68] as const;

/** The window centred on zero, over offsets from −HALF_TAPS to HALF_TAPS input samples. */
function blackmanHarris(offset: number): number {
  const angle = (Math.PI * offset) / HALF_TAPS;
  const [a0, a1, a2, a3] = WINDOW_WEIGHTS;
  return a0 + a1 * cos(angle) + a2 * cos(2 * angle) + a3 * cos(3 * angle);
}

/** sin(πx)/(πx) for a non-integer x. */
function sinc(x: number): number {
  return sin(Math.PI * x) / (Math.PI * x);
}

/**
 * The windowed-sinc taps that interpolate the point `phase / OVERSAMPLING` of a
 * sample after sample n, reading samples n − HALF_TAPS + 1 through n + HALF_TAPS.
 * Normalised to unit DC gain.
 */
function phaseTaps(phase: number): Float64Array {
  const taps = Float64Array.from({ length: 2 * HALF_TAPS }, (_, tap) => {
    const offset = phase / OVERSAMPLING - (tap - HALF_TAPS + 1);
    return sinc(offset) * blackmanHarris(offset);
  });
  let sum = 0;
  for (const tap of taps) {
    sum += tap;
  }
  return taps.map((tap) => tap / sum);
}

/** One filter per interpolated phase; phase 0 is the input sample itself. */
const PHASES = Array.from({ length: OVERSAMPLING - 1 }, (_, index) => phaseTaps(index + 1));

function interpolate(samples: Float32Array, first: number, taps: Float64Array): number {
  let sum = 0;
  let index = first;
  for (const tap of taps) {
    sum += tap * sampleAt(samples, index);
    index += 1;
  }
  return sum;
}

/** The largest magnitude in a channel's 4× oversampled stream, the signal silent past both ends. */
function oversampledPeak(samples: Float32Array): number {
  let peak = 0;
  let index = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
    for (const taps of PHASES) {
      peak = Math.max(peak, Math.abs(interpolate(samples, index - HALF_TAPS + 1, taps)));
    }
    index += 1;
  }
  return peak;
}

/**
 * True peak per ITU-R BS.1770-4 Annex 2: the maximum magnitude over each
 * channel's 4× oversampled stream, read before any decimation, in dBTP.
 */
export function truePeakDbtp(signal: StereoBuffer): number {
  requireStereo(signal);
  return amplitudeToDb(Math.max(oversampledPeak(signal.left), oversampledPeak(signal.right)));
}
