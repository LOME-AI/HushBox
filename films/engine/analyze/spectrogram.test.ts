import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { exp, log, sin } from '../dmath/dmath.js';

import { SPECTROGRAM_MAX_HZ, SPECTROGRAM_MIN_HZ, spectrogramPixels } from './spectrogram.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

function tone(frequency: number, seconds: number): StereoBuffer {
  const channel = Float32Array.from(
    { length: seconds * SAMPLE_RATE },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE)
  );
  return { left: channel, right: Float32Array.from(channel) };
}

/** A two-second log sweep from 40 Hz to 16 kHz, built with `dmath` so its digest holds on every engine. */
function sweep(): StereoBuffer {
  const seconds = 2;
  const ratio = log(16_000 / 40);
  const channel = Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, index) => {
    const t = index / SAMPLE_RATE;
    const phase = ((2 * Math.PI * 40 * seconds) / ratio) * (exp((t * ratio) / seconds) - 1);
    return 0.5 * sin(phase);
  });
  return { left: channel, right: Float32Array.from(channel) };
}

function brightestRow(pixels: Uint8Array, width: number, height: number, column: number): number {
  let best = 0;
  for (let row = 0; row < height; row += 1) {
    if ((pixels[row * width + column] ?? 0) > (pixels[best * width + column] ?? 0)) {
      best = row;
    }
  }
  return best;
}

describe('spectrogramPixels', () => {
  it('spans 20 Hz to 20 kHz', () => {
    expect([SPECTROGRAM_MIN_HZ, SPECTROGRAM_MAX_HZ]).toEqual([20, 20_000]);
  });

  it('holds one byte per pixel of the requested size', () => {
    const image = spectrogramPixels(tone(1000, 0.5), { width: 40, height: 30 });
    expect([image.width, image.height, image.pixels.length]).toEqual([40, 30, 1200]);
  });

  it('lights the row of the tone on a log-frequency axis', () => {
    const height = 300;
    const image = spectrogramPixels(tone(1000, 1), { width: 20, height });
    const fraction = Math.log(1000 / 20) / Math.log(20_000 / 20);
    const expectedRow = height - 0.5 - fraction * height;
    expect(Math.abs(brightestRow(image.pixels, 20, height, 10) - expectedRow)).toBeLessThanOrEqual(
      1
    );
  });

  it('draws digital silence black', () => {
    const silent = { left: new Float32Array(SAMPLE_RATE), right: new Float32Array(SAMPLE_RATE) };
    expect(
      spectrogramPixels(silent, { width: 8, height: 8 }).pixels.every((pixel) => pixel === 0)
    ).toBe(true);
  });

  it('computes the same pixels on every call', () => {
    const signal = sweep();
    const first = spectrogramPixels(signal, { width: 64, height: 48 });
    const second = spectrogramPixels(signal, { width: 64, height: 48 });
    expect(Buffer.from(second.pixels).equals(Buffer.from(first.pixels))).toBe(true);
  });

  it('matches the pinned digest of a sweep, bit for bit', () => {
    const { pixels } = spectrogramPixels(sweep(), { width: 64, height: 48 });
    expect(createHash('sha256').update(pixels).digest('hex')).toBe(
      '656b30046da30a2651725f6eb7c1ca222bf8ed7651c7d7fb0db1b44cef787e83'
    );
  });

  it('accepts a one-pixel picture', () => {
    expect(spectrogramPixels(tone(1000, 0.1), { width: 1, height: 1 }).pixels).toHaveLength(1);
  });

  it('refuses a picture with no rows', () => {
    expect(() => spectrogramPixels(tone(1000, 0.1), { width: 1, height: 0 })).toThrow(/height 0/);
  });
});
