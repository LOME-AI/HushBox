import { describe, expect, it } from 'vitest';

import { requireInRange, requireSampleCount } from './bounds.js';
import { nextAfter } from './dsp-test-support.js';

describe('requireInRange', () => {
  const closed = { min: -1, max: 1 };
  const open = { min: -1, max: 1, minOpen: true, maxOpen: true };

  it('returns a value inside the interval', () => {
    expect(requireInRange('pan', 0.5, closed)).toBe(0.5);
  });

  it('accepts a closed interval at its lower end', () => {
    expect(requireInRange('pan', -1, closed)).toBe(-1);
  });

  it('refuses the double just below a closed lower end', () => {
    expect(() => requireInRange('pan', nextAfter(-1, -1), closed)).toThrow(RangeError);
  });

  it('accepts a closed interval at its upper end', () => {
    expect(requireInRange('pan', 1, closed)).toBe(1);
  });

  it('refuses the double just above a closed upper end', () => {
    expect(() => requireInRange('pan', nextAfter(1, 1), closed)).toThrow(RangeError);
  });

  it('accepts the double just inside an open lower end', () => {
    expect(requireInRange('gain', nextAfter(-1, 1), open)).toBe(nextAfter(-1, 1));
  });

  it('refuses an open interval at its lower end', () => {
    expect(() => requireInRange('gain', -1, open)).toThrow(RangeError);
  });

  it('accepts the double just inside an open upper end', () => {
    expect(requireInRange('gain', nextAfter(1, -1), open)).toBe(nextAfter(1, -1));
  });

  it('refuses an open interval at its upper end', () => {
    expect(() => requireInRange('gain', 1, open)).toThrow(RangeError);
  });

  it('refuses NaN', () => {
    expect(() => requireInRange('gain', Number.NaN, closed)).toThrow(RangeError);
  });

  it('names the parameter, the value and the interval when it refuses', () => {
    expect(() => requireInRange('gain', 1, open)).toThrow('gain must be in (-1, 1), got 1');
  });

  it('writes a closed interval with square brackets', () => {
    expect(() => requireInRange('pan', 2, closed)).toThrow('pan must be in [-1, 1], got 2');
  });
});

describe('requireSampleCount', () => {
  it('accepts zero', () => {
    expect(requireSampleCount('samples', 0)).toBe(0);
  });

  it('refuses minus one', () => {
    expect(() => requireSampleCount('samples', -1)).toThrow(
      'samples must be a whole number of samples, zero or more, got -1'
    );
  });

  it('refuses a fraction of a sample', () => {
    expect(() => requireSampleCount('samples', 2.5)).toThrow(RangeError);
  });

  it('accepts the largest safe integer', () => {
    expect(requireSampleCount('samples', Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses the first integer past the safe range', () => {
    expect(() => requireSampleCount('samples', Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
