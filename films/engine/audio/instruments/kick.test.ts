import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { bandPower, nextAfter } from '../dsp/dsp-test-support.js';

import {
  itHoldsBounds,
  itKeepsTheContract,
  renderWith,
  risingCrossings,
} from './instrument-test-support.js';
import { kick } from './kick.js';

describe('kick', () => {
  itKeepsTheContract(kick, { raw: {} });

  itHoldsBounds(kick, [
    { key: 'startHz', accepted: 40, refused: nextAfter(40, -1) },
    { key: 'startHz', accepted: 1000, refused: nextAfter(1000, 1) },
    { key: 'endHz', accepted: 20, refused: nextAfter(20, -1) },
    { key: 'endHz', accepted: 200, refused: nextAfter(200, 1) },
    { key: 'decay', accepted: 0.05, refused: nextAfter(0.05, -1) },
    { key: 'decay', accepted: 4, refused: nextAfter(4, 1) },
    { key: 'drive', accepted: 0.5, refused: nextAfter(0.5, -1) },
    { key: 'drive', accepted: 8, refused: nextAfter(8, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(kick, { decay: 0.123_457 });
    expect(buffer.left).toHaveLength(Math.round(0.123_457 * SAMPLE_RATE));
  });

  it('settles on its end frequency', () => {
    const { buffer } = renderWith(kick, { endHz: 50, decay: 1 });
    // A tenth of a second, half a second in: five cycles of 50 Hz.
    const window = buffer.left.subarray(SAMPLE_RATE / 2, SAMPLE_RATE / 2 + SAMPLE_RATE / 10);
    expect(risingCrossings(window)).toBe(5);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(kick, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });

  it('carries its click above 2 kHz in the attack, at least 20 dB over the body', () => {
    const { buffer } = renderWith(kick, {});
    const window = { length: SAMPLE_RATE / 200 };
    const band = { low: 2000, high: 20_000 };
    const attack = bandPower(buffer.left, band, { from: 0, ...window });
    const body = bandPower(buffer.left, band, { from: SAMPLE_RATE / 10, ...window });
    expect(attack).toBeGreaterThan(body * 100);
  });
});
