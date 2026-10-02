import { describe, expect, it } from 'vitest';

import {
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
} from '../constants.ts';
import { mediaOutputBytes } from './output-bytes.ts';

describe('mediaOutputBytes', () => {
  it('estimates one generated image at the image byte estimate', () => {
    expect(mediaOutputBytes('image', 1)).toBe(ESTIMATED_IMAGE_BYTES);
  });

  it('scales the video estimate by the second count', () => {
    expect(mediaOutputBytes('video', 4)).toBe(4 * ESTIMATED_VIDEO_BYTES_PER_SECOND);
  });

  it('scales the audio estimate by the second count', () => {
    expect(mediaOutputBytes('audio', 10)).toBe(10 * ESTIMATED_AUDIO_BYTES_PER_SECOND);
  });

  it('estimates nothing for zero units', () => {
    expect(mediaOutputBytes('video', 0)).toBe(0);
  });

  it('refuses a fractional unit count rather than estimating a fractional byte', () => {
    expect(() => mediaOutputBytes('video', 1.5)).toThrow(RangeError);
  });

  it('refuses a negative unit count', () => {
    expect(() => mediaOutputBytes('image', -1)).toThrow(RangeError);
  });
});
