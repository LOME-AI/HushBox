import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';

import { prewarp } from './prewarp.js';

describe('prewarp', () => {
  it('is 0 at 0 Hz', () => {
    expect(prewarp(0)).toBe(0);
  });

  it('is tan(π/4) = 1 at a quarter of the sample rate', () => {
    expect(prewarp(SAMPLE_RATE / 4)).toBeCloseTo(1, 15);
  });

  it('is tan(π·cutoff / SAMPLE_RATE) between', () => {
    expect(prewarp(4000)).toBeCloseTo(Math.tan(Math.PI / 12), 15);
  });
});
