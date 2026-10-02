import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { nextAfter } from '../dsp/dsp-test-support.js';

import {
  itHoldsBounds,
  itKeepsTheContract,
  renderWith,
  risingCrossings,
} from './instrument-test-support.js';
import { tom } from './tom.js';

describe('tom', () => {
  itKeepsTheContract(tom, { raw: {} });

  itHoldsBounds(tom, [
    { key: 'toneHz', accepted: 50, refused: nextAfter(50, -1) },
    { key: 'toneHz', accepted: 400, refused: nextAfter(400, 1) },
    { key: 'decay', accepted: 0.05, refused: nextAfter(0.05, -1) },
    { key: 'decay', accepted: 3, refused: nextAfter(3, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(tom, { decay: 0.345_678 });
    expect(buffer.left).toHaveLength(Math.round(0.345_678 * SAMPLE_RATE));
  });

  it('settles on its tone', () => {
    const { buffer } = renderWith(tom, { toneHz: 100, decay: 1 });
    // A tenth of a second, half a second in: ten cycles of 100 Hz.
    const window = buffer.left.subarray(SAMPLE_RATE / 2, SAMPLE_RATE / 2 + SAMPLE_RATE / 10);
    expect(risingCrossings(window)).toBe(10);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(tom, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
