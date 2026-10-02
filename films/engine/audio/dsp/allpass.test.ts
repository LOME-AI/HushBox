import { describe, expect, it } from 'vitest';

import { allpass } from './allpass.js';
import { goertzelPower, nextAfter } from './dsp-test-support.js';

function impulse(length: number): Float32Array {
  const signal = new Float32Array(length);
  signal[0] = 1;
  return signal;
}

describe('allpass', () => {
  it('answers an impulse with −g, then (1 − g²)·g^(k−1) every delay', () => {
    const response = allpass(impulse(7), { delay: 3, gain: 0.5 });
    expect([...response]).toEqual([-0.5, 0, 0, 0.75, 0, 0, 0.375]);
  });

  it('passes every frequency at unity gain', () => {
    // The impulse response has decayed below float precision well inside 480 samples,
    // so its transform at any frequency is the filter's response there.
    const response = allpass(impulse(480), { delay: 7, gain: 0.5 });
    for (const frequency of [100, 1000, 5000, 11_000, 20_000]) {
      expect(goertzelPower(response, frequency, { from: 0, length: 480 })).toBeCloseTo(1, 6);
    }
  });

  it('accepts a delay of one sample', () => {
    expect(() => allpass(impulse(4), { delay: 1, gain: 0.5 })).not.toThrow();
  });

  it('refuses a delay just under one sample', () => {
    expect(() => allpass(impulse(4), { delay: nextAfter(1, -1), gain: 0.5 })).toThrow(
      /delay must be in \[1, 4\]/
    );
  });

  it('accepts a delay as long as the input', () => {
    expect(() => allpass(impulse(4), { delay: 4, gain: 0.5 })).not.toThrow();
  });

  it('refuses a delay just longer than the input', () => {
    expect(() => allpass(impulse(4), { delay: nextAfter(4, 1), gain: 0.5 })).toThrow(RangeError);
  });

  it('accepts the gain just above −1', () => {
    expect(() => allpass(impulse(4), { delay: 1, gain: nextAfter(-1, 1) })).not.toThrow();
  });

  it('refuses a gain of −1', () => {
    expect(() => allpass(impulse(4), { delay: 1, gain: -1 })).toThrow(/gain must be in \(-1, 1\)/);
  });

  it('accepts the gain just below 1', () => {
    expect(() => allpass(impulse(4), { delay: 1, gain: nextAfter(1, -1) })).not.toThrow();
  });

  it('refuses a gain of 1', () => {
    expect(() => allpass(impulse(4), { delay: 1, gain: 1 })).toThrow(RangeError);
  });
});
