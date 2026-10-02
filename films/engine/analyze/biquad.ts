import { cos, sin } from '../dmath/dmath.js';

/** A biquad section's coefficients, normalised so a0 = 1. */
export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** tan(x) through the portable sine and cosine, for the bilinear transform's prewarping. */
export function tangent(x: number): number {
  return sin(x) / cos(x);
}

/** The section applied to a signal in direct form I, in double precision. */
export function filterBiquad(input: Float32Array | Float64Array, section: Biquad): Float64Array {
  const { b0, b1, b2, a1, a2 } = section;
  const output = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (const [index, x0] of input.entries()) {
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}
