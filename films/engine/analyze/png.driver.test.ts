import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { exp, log, sin } from '../dmath/dmath.js';

import { spectrogramPng, waveformPng } from './png.driver.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { AnalysisCue } from './signal.js';

/** Four decaying 110 Hz hits over a rising 220 Hz to 3.5 kHz glide, two seconds, built with `dmath`. */
function testSignal(): { signal: StereoBuffer; cues: AnalysisCue[] } {
  const hitEvery = SAMPLE_RATE / 2;
  const ratio = 16;
  const channel = Float32Array.from({ length: 2 * SAMPLE_RATE }, (_, index) => {
    const since = index % hitEvery;
    const hit = 0.6 * exp(-since / 3000) * sin((2 * Math.PI * 110 * since) / SAMPLE_RATE);
    const t = index / SAMPLE_RATE;
    const glidePhase = ((2 * Math.PI * 220 * 2) / log(ratio)) * (exp((t * log(ratio)) / 2) - 1);
    return hit + 0.2 * sin(glidePhase);
  });
  const cues = [0, 1, 2, 3].map((hit) => ({ id: `hit-${String(hit)}`, sample: hit * hitEvery }));
  return { signal: { left: channel, right: channel.map((sample) => sample * 0.8) }, cues };
}

describe('spectrogramPng', () => {
  it('encodes a greyscale PNG of the requested size', async () => {
    const png = await spectrogramPng(testSignal().signal, { width: 480, height: 270 });
    const metadata = await sharp(png).metadata();
    expect([metadata.format, metadata.width, metadata.height, metadata.channels]).toEqual([
      'png',
      480,
      270,
      1,
    ]);
  });

  it('encodes identical bytes on every call', async () => {
    const { signal } = testSignal();
    const first = await spectrogramPng(signal, { width: 480, height: 270 });
    const second = await spectrogramPng(signal, { width: 480, height: 270 });
    expect(second.equals(first)).toBe(true);
  });
});

describe('waveformPng', () => {
  it('encodes a greyscale PNG of the requested size', async () => {
    const { signal, cues } = testSignal();
    const metadata = await sharp(
      await waveformPng(signal, cues, { width: 480, height: 200 })
    ).metadata();
    expect([metadata.format, metadata.width, metadata.height, metadata.channels]).toEqual([
      'png',
      480,
      200,
      1,
    ]);
  });

  it('encodes identical bytes on every call', async () => {
    const { signal, cues } = testSignal();
    const first = await waveformPng(signal, cues, { width: 480, height: 200 });
    const second = await waveformPng(signal, cues, { width: 480, height: 200 });
    expect(second.equals(first)).toBe(true);
  });
});
