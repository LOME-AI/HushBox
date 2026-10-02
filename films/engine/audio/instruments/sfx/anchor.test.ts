import { describe, expect, it } from 'vitest';

import { anchoredAt, anchoredAtEnd, reversed } from './anchor.js';

import type { StereoBuffer } from '../../dsp/index.js';

function stereo(left: number[], right: number[]): StereoBuffer {
  return { left: new Float32Array(left), right: new Float32Array(right) };
}

describe('reversed', () => {
  it('plays each channel backwards', () => {
    const backwards = reversed(stereo([1, 2, 3], [4, 5, 6]));
    expect([...backwards.left, ...backwards.right]).toEqual([3, 2, 1, 6, 5, 4]);
  });

  it('leaves the buffer it was given unchanged', () => {
    const buffer = stereo([1, 2], [3, 4]);
    reversed(buffer);
    expect([...buffer.left, ...buffer.right]).toEqual([1, 2, 3, 4]);
  });
});

describe('anchoredAtEnd', () => {
  it('lands the cue one past the last sample', () => {
    expect(anchoredAtEnd(stereo([0.1, 0.2, 0.3], [0, 0, 0])).anchorOffset).toBe(3);
  });

  it('scales the loudest sample to full scale', () => {
    const { buffer } = anchoredAtEnd(stereo([0.25, -0.5], [0, 0.125]));
    expect([...buffer.left, ...buffer.right]).toEqual([0.5, -1, 0, 0.25]);
  });

  it('leaves a silent buffer silent', () => {
    const { buffer } = anchoredAtEnd(stereo([0, 0], [0, 0]));
    expect([...buffer.left, ...buffer.right]).toEqual([0, 0, 0, 0]);
  });
});

describe('anchoredAt', () => {
  it('lands the cue on the sample it is given, wherever the loudest sample is', () => {
    expect(anchoredAt(stereo([0.9, 0.1, 0.2], [0, 0, 0]), 1).anchorOffset).toBe(1);
  });

  it('scales the loudest sample to full scale', () => {
    const { buffer } = anchoredAt(stereo([0.25, -0.5], [0, 0.125]), 0);
    expect([...buffer.left, ...buffer.right]).toEqual([0.5, -1, 0, 0.25]);
  });

  it('accepts the sample one past the last', () => {
    expect(anchoredAt(stereo([0.1, 0.2], [0, 0]), 2).anchorOffset).toBe(2);
  });

  it.each([-1, 3, 0.5, Number.NaN])(
    'refuses an anchor of %d in a sound of two samples',
    (sample) => {
      expect(() => anchoredAt(stereo([0.1, 0.2], [0, 0]), sample)).toThrow(
        /anchor must be a whole sample from 0 to 2/
      );
    }
  );
});
