import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { bandPower, nextAfter } from '../dsp/dsp-test-support.js';

import { clap } from './clap.js';
import { itHoldsBounds, itKeepsTheContract, renderWith } from './instrument-test-support.js';

/** Root-mean-square level of a run of samples. */
function rms(signal: Float32Array): number {
  let sum = 0;
  for (const sample of signal) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / signal.length);
}

describe('clap', () => {
  itKeepsTheContract(clap, { raw: {} });

  itHoldsBounds(clap, [
    { key: 'toneHz', accepted: 500, refused: nextAfter(500, -1) },
    { key: 'toneHz', accepted: 4000, refused: nextAfter(4000, 1) },
    { key: 'decay', accepted: 0.05, refused: nextAfter(0.05, -1) },
    { key: 'decay', accepted: 2, refused: nextAfter(2, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(clap, { decay: 0.456_789 });
    expect(buffer.left).toHaveLength(Math.round(0.456_789 * SAMPLE_RATE));
  });

  it.each([11, 22])('claps again %i ms after the first hand', (milliseconds) => {
    const { buffer } = renderWith(clap, {});
    const at = Math.round((milliseconds / 1000) * SAMPLE_RATE);
    const span = SAMPLE_RATE / 500;
    expect(rms(buffer.left.subarray(at, at + span))).toBeGreaterThan(
      rms(buffer.left.subarray(at - span, at))
    );
  });

  it('centres its noise on its tone', () => {
    const { buffer } = renderWith(clap, { toneHz: 1200 });
    const window = { from: 0, length: SAMPLE_RATE / 10 };
    const near = bandPower(buffer.left, { low: 800, high: 1800 }, window);
    const far = bandPower(buffer.left, { low: 8000, high: 9000 }, window);
    expect(near).toBeGreaterThan(far * 10);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(clap, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
