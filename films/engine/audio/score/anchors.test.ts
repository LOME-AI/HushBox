import { describe, expect, it } from 'vitest';

import { anchorPoint } from './anchors.js';

import type { StereoBuffer } from '../dsp/index.js';

/** Eight samples whose loudest, −0.9 on the right, is at index 5. */
function buffer(): StereoBuffer {
  return {
    left: Float32Array.of(0.1, 0.3, 0.2, 0.5, 0.4, 0.6, 0.2, 0.1),
    right: Float32Array.of(0.1, 0.2, 0.1, 0.4, 0.3, -0.9, 0.2, 0.1),
  };
}

describe('anchorPoint', () => {
  it('lands a start anchor on the first sample', () => {
    expect(anchorPoint('start', { buffer: buffer(), anchorOffset: 5 })).toEqual({
      anchor: 'start',
      offset: 0,
    });
  });

  it('lands an end anchor one past the last sample', () => {
    expect(anchorPoint('end', { buffer: buffer(), anchorOffset: 0 })).toEqual({
      anchor: 'end',
      offset: 8,
    });
  });

  it('lands a peak anchor on the loudest sample of either channel', () => {
    expect(anchorPoint('peak', { buffer: buffer(), anchorOffset: 0 })).toEqual({
      anchor: 'peak',
      offset: 5,
    });
  });

  it('lands a peak anchor on the first of two equally loud samples', () => {
    const level = { left: Float32Array.of(0, 0.5, 0, 0.5), right: new Float32Array(4) };
    expect(anchorPoint('peak', { buffer: level, anchorOffset: 0 }).offset).toBe(1);
  });

  it('with no anchor named, lands the instrument’s own offset and names it start at the first sample', () => {
    expect(anchorPoint(null, { buffer: buffer(), anchorOffset: 0 })).toEqual({
      anchor: 'start',
      offset: 0,
    });
  });

  it('with no anchor named, names an offset one past the last sample an end', () => {
    expect(anchorPoint(null, { buffer: buffer(), anchorOffset: 8 })).toEqual({
      anchor: 'end',
      offset: 8,
    });
  });

  it('with no anchor named, names an offset inside the sound a peak', () => {
    expect(anchorPoint(null, { buffer: buffer(), anchorOffset: 5 })).toEqual({
      anchor: 'peak',
      offset: 5,
    });
  });
});
