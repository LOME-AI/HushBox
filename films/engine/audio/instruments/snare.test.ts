import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { bandPower, nextAfter } from '../dsp/dsp-test-support.js';

import { itHoldsBounds, itKeepsTheContract, renderWith } from './instrument-test-support.js';
import { snare } from './snare.js';

describe('snare', () => {
  itKeepsTheContract(snare, { raw: {} });

  itHoldsBounds(snare, [
    { key: 'toneHz', accepted: 100, refused: nextAfter(100, -1) },
    { key: 'toneHz', accepted: 500, refused: nextAfter(500, 1) },
    { key: 'decay', accepted: 0.05, refused: nextAfter(0.05, -1) },
    { key: 'decay', accepted: 2, refused: nextAfter(2, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(snare, { decay: 0.234_567 });
    expect(buffer.left).toHaveLength(Math.round(0.234_567 * SAMPLE_RATE));
  });

  it('sounds its wires louder than its body', () => {
    const { buffer } = renderWith(snare, {});
    const window = { from: 0, length: SAMPLE_RATE / 20 };
    const wires = bandPower(buffer.left, { low: 1500, high: 6000 }, window);
    const body = bandPower(buffer.left, { low: 100, high: 500 }, window);
    expect(wires).toBeGreaterThan(body);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(snare, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
