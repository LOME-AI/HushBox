import { SAMPLE_RATE } from '../time/grid.js';
import { cos } from '../dmath/dmath.js';

import { filterBiquad, tangent } from './biquad.js';
import { requireStereo, sampleAt } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { Biquad } from './biquad.js';

/** The top of the low band whose mono compatibility a mix is checked for. */
export const LOW_BAND_CUTOFF_HZ = 120;

/** A bilinear-transform low-pass section at LOW_BAND_CUTOFF_HZ with quality factor `q`. */
function lowPassSection(q: number): Biquad {
  const k = tangent((Math.PI * LOW_BAND_CUTOFF_HZ) / SAMPLE_RATE);
  const a0 = 1 + k / q + k * k;
  const b0 = (k * k) / a0;
  return { b0, b1: 2 * b0, b2: b0, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
}

/** A fourth-order Butterworth low-pass: two sections at the pole angles π/8 and 3π/8. */
const LOW_PASS_SECTIONS = [Math.PI / 8, (3 * Math.PI) / 8].map((angle) =>
  lowPassSection(1 / (2 * cos(angle)))
);

/** A channel through the fourth-order Butterworth low-pass at LOW_BAND_CUTOFF_HZ. */
export function lowBand(channel: Float32Array): Float64Array {
  let output: Float32Array | Float64Array = channel;
  for (const section of LOW_PASS_SECTIONS) {
    output = filterBiquad(output, section);
  }
  return Float64Array.from(output);
}

/** Σlr / √(Σl²·Σr²), or null when either channel is silent. */
function correlate(
  left: Float32Array | Float64Array,
  right: Float32Array | Float64Array
): number | null {
  let leftEnergy = 0;
  let rightEnergy = 0;
  let cross = 0;
  let index = 0;
  for (const l of left) {
    const r = sampleAt(right, index);
    leftEnergy += l * l;
    rightEnergy += r * r;
    cross += l * r;
    index += 1;
  }
  if (leftEnergy === 0 || rightEnergy === 0) {
    return null;
  }
  return cross / (Math.sqrt(leftEnergy) * Math.sqrt(rightEnergy));
}

/** The phase correlation of the two channels, from −1 to +1; null when either is silent. */
export function stereoCorrelation(signal: StereoBuffer): number | null {
  requireStereo(signal);
  return correlate(signal.left, signal.right);
}

/** The phase correlation below LOW_BAND_CUTOFF_HZ; null when either channel's low band is silent. */
export function lowBandCorrelation(signal: StereoBuffer): number | null {
  requireStereo(signal);
  return correlate(lowBand(signal.left), lowBand(signal.right));
}
