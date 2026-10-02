import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith, risingCrossings } from '../instrument-test-support.js';

import { pop } from './pop.js';
import { itKeepsTheSfxContract } from './sfx-test-support.js';

describe('pop', () => {
  itKeepsTheSfxContract(pop, { raw: {}, anchor: 'start' });

  itHoldsBounds(pop, [
    { key: 'fromHz', accepted: 100, refused: nextAfter(100, -1) },
    { key: 'fromHz', accepted: 1000, refused: nextAfter(1000, 1) },
    { key: 'octaves', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'octaves', accepted: 4, refused: nextAfter(4, 1) },
    { key: 'decay', accepted: 0.01, refused: nextAfter(0.01, -1) },
    { key: 'decay', accepted: 0.3, refused: nextAfter(0.3, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(pop, { decay: 0.054_321 });
    expect(buffer.left).toHaveLength(Math.round(0.054_321 * SAMPLE_RATE));
  });

  it('sweeps up from its start to its octaves above', () => {
    const { buffer } = renderWith(pop, { fromHz: 250, octaves: 2, decay: 0.3 });
    // Fiftieths of a second: the first averaging near 500 Hz, the last settled on 1 kHz.
    const length = SAMPLE_RATE / 50;
    const early = risingCrossings(buffer.left.subarray(0, length));
    const late = risingCrossings(buffer.left.subarray(buffer.left.length - length));
    expect(early).toBeLessThan(13);
    expect(late).toBeGreaterThanOrEqual(19);
  });

  it('holds its pitch when it sweeps no octaves', () => {
    const { buffer } = renderWith(pop, { fromHz: 400, octaves: 0, decay: 0.3 });
    const late = buffer.left.subarray(buffer.left.length - SAMPLE_RATE / 10);
    expect(risingCrossings(late)).toBe(40);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(pop, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
