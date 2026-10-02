import { describe, expect, it } from 'vitest';

import { requireCueSample, requireStereo, sampleAt } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

function silence(left: number, right: number = left): StereoBuffer {
  return { left: new Float32Array(left), right: new Float32Array(right) };
}

describe('requireStereo', () => {
  it('returns the length of a one-sample signal', () => {
    expect(requireStereo(silence(1))).toBe(1);
  });

  it('refuses an empty signal', () => {
    expect(() => requireStereo(silence(0))).toThrow(/empty/);
  });

  it('accepts channels of equal length', () => {
    expect(requireStereo(silence(48))).toBe(48);
  });

  it('refuses channels whose lengths differ by one sample', () => {
    expect(() => requireStereo(silence(48, 49))).toThrow(/48.*49/);
  });
});

describe('requireCueSample', () => {
  it('accepts a cue on the first sample', () => {
    expect(() => {
      requireCueSample({ id: 'hit', sample: 0 }, 100);
    }).not.toThrow();
  });

  it('refuses a cue one sample before the signal starts', () => {
    expect(() => {
      requireCueSample({ id: 'hit', sample: -1 }, 100);
    }).toThrow(/hit/);
  });

  it('accepts a cue at the end of the signal', () => {
    expect(() => {
      requireCueSample({ id: 'end', sample: 100 }, 100);
    }).not.toThrow();
  });

  it('refuses a cue one sample past the end of the signal', () => {
    expect(() => {
      requireCueSample({ id: 'late', sample: 101 }, 100);
    }).toThrow(/late.*101/);
  });

  it('refuses a cue between samples', () => {
    expect(() => {
      requireCueSample({ id: 'half', sample: 10.5 }, 100);
    }).toThrow(/half/);
  });
});

describe('sampleAt', () => {
  const samples = Float32Array.of(0.5, -0.25);

  it('reads a sample inside the array', () => {
    expect(sampleAt(samples, 1)).toBe(-0.25);
  });

  it('reads silence one sample past the end', () => {
    expect(sampleAt(samples, 2)).toBe(0);
  });

  it('reads silence one sample before the start', () => {
    expect(sampleAt(samples, -1)).toBe(0);
  });
});
