import { describe, expect, it } from 'vitest';

import { SILENCE_FADE, silenced } from './silence.js';

import type { StereoBuffer } from '../dsp/index.js';

function level(samples: number, value: number): StereoBuffer {
  return {
    left: new Float32Array(samples).fill(value),
    right: new Float32Array(samples).fill(-value),
  };
}

describe('silenced', () => {
  const span = { cueId: 'gap', from: 1000, to: 2000 };

  it('outputs digital zero across the span, in both channels', () => {
    const output = silenced(level(3000, 0.5), [span]);
    expect([...output.left.subarray(1000, 2000)].every((sample) => Object.is(sample, 0))).toBe(
      true
    );
    expect([...output.right.subarray(1000, 2000)].every((sample) => Object.is(sample, 0))).toBe(
      true
    );
  });

  it('fades out over the samples just before the span, so the cut does not click', () => {
    const output = silenced(level(3000, 0.5), [span]);
    expect(output.left[1000 - SILENCE_FADE - 1]).toBe(0.5);
    expect(output.left[1000 - SILENCE_FADE]).toBe(0.5);
    expect(output.left[999]).toBeCloseTo(0.5 / SILENCE_FADE, 6);
  });

  it('leaves everything after the span as it was', () => {
    expect(silenced(level(3000, 0.5), [span]).right[2000]).toBe(-0.5);
  });

  it('silences every span it is given', () => {
    const output = silenced(level(3000, 0.5), [span, { cueId: 'end', from: 2500, to: 3000 }]);
    expect([output.left[1500], output.left[2750], output.left[2200]]).toEqual([0, 0, 0.5]);
  });

  it('starts a span on the first sample with nothing to fade', () => {
    const output = silenced(level(100, 0.5), [{ cueId: 'open', from: 0, to: 10 }]);
    expect([output.left[0], output.left[10]]).toEqual([0, 0.5]);
  });

  it('fades only what there is when a span starts within the fade of the first sample', () => {
    const output = silenced(level(100, 0.5), [{ cueId: 'soon', from: 5, to: 10 }]);
    expect(output.left[0]).toBeCloseTo((0.5 * 5) / SILENCE_FADE, 6);
  });

  it('leaves the input as it was', () => {
    const input = level(3000, 0.5);
    silenced(input, [span]);
    expect(input.left[1500]).toBe(0.5);
  });
});
