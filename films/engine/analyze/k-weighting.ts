import { SAMPLE_RATE } from '../time/grid.js';
import { pow } from '../dmath/dmath.js';

import { filterBiquad, tangent } from './biquad.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { Biquad } from './biquad.js';

/** Both channels after the K-weighting filter, in double precision. */
export interface WeightedStereo {
  readonly left: Float64Array;
  readonly right: Float64Array;
}

// The analogue prototypes behind ITU-R BS.1770-4's 48 kHz coefficient tables,
// as libebur128 derives them, so the tables are computed for the film sample
// rate rather than typed.
const SHELF_FREQUENCY = 1681.974_450_955_533;
const SHELF_GAIN_DB = 3.999_843_853_973_347;
const SHELF_Q = 0.707_175_236_955_419_6;
const SHELF_BAND_EXPONENT = 0.499_666_774_154_541_6;
const HIGH_PASS_FREQUENCY = 38.135_470_876_024_44;
const HIGH_PASS_Q = 0.500_327_037_323_877_3;

function shelf(): Biquad {
  const k = tangent((Math.PI * SHELF_FREQUENCY) / SAMPLE_RATE);
  const vh = pow(10, SHELF_GAIN_DB / 20);
  const vb = pow(vh, SHELF_BAND_EXPONENT);
  const a0 = 1 + k / SHELF_Q + k * k;
  return {
    b0: (vh + (vb * k) / SHELF_Q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / SHELF_Q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / SHELF_Q + k * k) / a0,
  };
}

function highPass(): Biquad {
  const k = tangent((Math.PI * HIGH_PASS_FREQUENCY) / SAMPLE_RATE);
  const a0 = 1 + k / HIGH_PASS_Q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / HIGH_PASS_Q + k * k) / a0,
  };
}

/** Stage 1 of the K-weighting filter: the head's acoustic high shelf. */
export const K_SHELF = shelf();

/** Stage 2 of the K-weighting filter: the revised low-frequency B-curve high-pass. */
export const K_HIGH_PASS = highPass();

function kWeight(channel: Float32Array): Float64Array {
  return filterBiquad(filterBiquad(channel, K_SHELF), K_HIGH_PASS);
}

export function kWeightStereo(signal: StereoBuffer): WeightedStereo {
  return { left: kWeight(signal.left), right: kWeight(signal.right) };
}
