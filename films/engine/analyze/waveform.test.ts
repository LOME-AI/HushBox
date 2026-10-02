import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { exp, sin } from '../dmath/dmath.js';

import { MARKER_LEVEL, WAVEFORM_LEVEL, waveformPixels } from './waveform.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

function silence(length: number): StereoBuffer {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

function column(pixels: Uint8Array, width: number, height: number, x: number): number[] {
  return Array.from({ length: height }, (_, row) => pixels[row * width + x] ?? -1);
}

/** Three decaying 200 Hz bursts, the right channel at half the left's level, built with `dmath`. */
function bursts(): StereoBuffer {
  const left = Float32Array.from({ length: SAMPLE_RATE }, (_, index) => {
    const since = index % (SAMPLE_RATE / 3);
    return 0.9 * exp(-since / 2000) * sin((2 * Math.PI * 200 * since) / SAMPLE_RATE);
  });
  return { left, right: left.map((sample) => sample / 2) };
}

describe('waveformPixels', () => {
  it('holds one byte per pixel of the requested size', () => {
    const image = waveformPixels(silence(100), [], { width: 10, height: 6 });
    expect([image.width, image.height, image.pixels.length]).toEqual([10, 6, 60]);
  });

  it('draws digital silence as one centre line in each channel lane', () => {
    const { pixels } = waveformPixels(silence(100), [], { width: 10, height: 6 });
    // Lanes of three rows each: the left channel's centre is row 1, the right's row 4.
    expect(column(pixels, 10, 6, 3)).toEqual([0, WAVEFORM_LEVEL, 0, 0, WAVEFORM_LEVEL, 0]);
  });

  it('fills each lane of a full-scale square wave from top to bottom', () => {
    const square = Float32Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? 1 : -1));
    const { pixels } = waveformPixels({ left: square, right: Float32Array.from(square) }, [], {
      width: 10,
      height: 6,
    });
    expect(column(pixels, 10, 6, 7)).toEqual(Array.from({ length: 6 }, () => WAVEFORM_LEVEL));
  });

  it('draws a dashed marker in the column of a cue', () => {
    const { pixels } = waveformPixels(silence(100), [{ id: 'hit', sample: 50 }], {
      width: 10,
      height: 16,
    });
    const marked = column(pixels, 10, 16, 5).filter((pixel) => pixel === MARKER_LEVEL).length;
    expect(marked).toBeGreaterThan(4);
    expect(marked).toBeLessThan(16);
  });

  it('draws a cue at the signal end in the last column', () => {
    const { pixels } = waveformPixels(silence(100), [{ id: 'end', sample: 100 }], {
      width: 10,
      height: 16,
    });
    expect(column(pixels, 10, 16, 9)).toContain(MARKER_LEVEL);
  });

  it('refuses a cue one sample past the signal end', () => {
    expect(() =>
      waveformPixels(silence(100), [{ id: 'late', sample: 101 }], { width: 10, height: 16 })
    ).toThrow(/late/);
  });

  it('draws a signal shorter than the picture is wide', () => {
    const left = Float32Array.of(1, -1);
    const { pixels } = waveformPixels({ left, right: Float32Array.from(left) }, [], {
      width: 4,
      height: 4,
    });
    expect(column(pixels, 4, 4, 0)).toEqual([WAVEFORM_LEVEL, 0, WAVEFORM_LEVEL, 0]);
    expect(column(pixels, 4, 4, 3)).toEqual([0, WAVEFORM_LEVEL, 0, WAVEFORM_LEVEL]);
  });

  it('accepts the two-row minimum height', () => {
    expect(waveformPixels(silence(10), [], { width: 2, height: 2 }).pixels).toHaveLength(4);
  });

  it('refuses a one-row picture', () => {
    expect(() => waveformPixels(silence(10), [], { width: 2, height: 1 })).toThrow(/height 1/);
  });

  it('computes the same pixels on every call', () => {
    const cues = [{ id: 'a', sample: 16_000 }];
    const first = waveformPixels(bursts(), cues, { width: 64, height: 48 });
    const second = waveformPixels(bursts(), cues, { width: 64, height: 48 });
    expect(Buffer.from(second.pixels).equals(Buffer.from(first.pixels))).toBe(true);
  });

  it('matches the pinned digest of three bursts, bit for bit', () => {
    const { pixels } = waveformPixels(bursts(), [{ id: 'a', sample: 16_000 }], {
      width: 64,
      height: 48,
    });
    expect(createHash('sha256').update(pixels).digest('hex')).toBe(
      '0ebb2603dd8ee954b60bfd016e7e63e306790800603ab377450e297eaecf6f7d'
    );
  });
});
