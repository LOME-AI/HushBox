import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith, risingCrossings } from '../instrument-test-support.js';

import { itKeepsTheSfxContract } from './sfx-test-support.js';
import { subPulse } from './sub-pulse.js';

describe('subPulse', () => {
  itKeepsTheSfxContract(subPulse, { raw: {}, anchor: 'start' });

  itHoldsBounds(subPulse, [
    { key: 'toneHz', accepted: 20, refused: nextAfter(20, -1) },
    { key: 'toneHz', accepted: 120, refused: nextAfter(120, 1) },
    { key: 'decay', accepted: 0.1, refused: nextAfter(0.1, -1) },
    { key: 'decay', accepted: 4, refused: nextAfter(4, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(subPulse, { decay: 0.345_67 });
    expect(buffer.left).toHaveLength(Math.round(0.345_67 * SAMPLE_RATE));
  });

  it('settles on its tone', () => {
    const { buffer } = renderWith(subPulse, { toneHz: 50, decay: 2 });
    // A fifth of a second, one second in: ten cycles of 50 Hz.
    const window = buffer.left.subarray(SAMPLE_RATE, SAMPLE_RATE + SAMPLE_RATE / 5);
    expect(risingCrossings(window)).toBe(10);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(subPulse, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
