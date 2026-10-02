import { describe, expect, it } from 'vitest';

import { filterBiquad, tangent } from './biquad.js';

import type { Biquad } from './biquad.js';

function impulse(length: number): Float32Array {
  const signal = new Float32Array(length);
  signal[0] = 1;
  return signal;
}

describe('tangent', () => {
  it('agrees with Math.tan across (−π/2, π/2)', () => {
    for (const x of [-1.5, -0.7, -0.1, 0.0022, 0.1, 0.7, 1.5]) {
      expect(tangent(x)).toBeCloseTo(Math.tan(x), 14);
    }
  });

  it('is zero at zero', () => {
    expect(tangent(0)).toBe(0);
  });
});

describe('filterBiquad', () => {
  it('passes a signal through the identity section unchanged', () => {
    const identity: Biquad = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    const input = Float32Array.from([0.5, -0.25, 1, 0]);
    expect([...filterBiquad(input, identity)]).toEqual([0.5, -0.25, 1, 0]);
  });

  it('applies the feed-forward taps to past inputs', () => {
    const average: Biquad = { b0: 0.5, b1: 0.25, b2: 0.25, a1: 0, a2: 0 };
    expect([...filterBiquad(impulse(4), average)]).toEqual([0.5, 0.25, 0.25, 0]);
  });

  it('subtracts the feedback taps applied to past outputs', () => {
    const decay: Biquad = { b0: 1, b1: 0, b2: 0, a1: -0.5, a2: 0.125 };
    // y[n] = x[n] + 0.5·y[n−1] − 0.125·y[n−2]
    expect([...filterBiquad(impulse(4), decay)]).toEqual([1, 0.5, 0.125, 0]);
  });

  it('returns a signal as long as its input', () => {
    const identity: Biquad = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    expect(filterBiquad(new Float32Array(7), identity)).toHaveLength(7);
  });
});
