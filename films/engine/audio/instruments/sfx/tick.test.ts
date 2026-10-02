import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { goertzelPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { itKeepsTheSfxContract } from './sfx-test-support.js';
import { tick } from './tick.js';

describe('tick', () => {
  itKeepsTheSfxContract(tick, { raw: {}, anchor: 'start' });

  itHoldsBounds(tick, [
    { key: 'toneHz', accepted: 1000, refused: nextAfter(1000, -1) },
    { key: 'toneHz', accepted: 6000, refused: nextAfter(6000, 1) },
    { key: 'decay', accepted: 0.003, refused: nextAfter(0.003, -1) },
    { key: 'decay', accepted: 0.1, refused: nextAfter(0.1, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(tick, { decay: 0.012_345 });
    expect(buffer.left).toHaveLength(Math.round(0.012_345 * SAMPLE_RATE));
  });

  it('rings at its tone', () => {
    const { buffer } = renderWith(tick, { toneHz: 3000, decay: 0.05 });
    // A hundredth of a second: whole cycles of every multiple of 100 Hz.
    const window = { from: 0, length: SAMPLE_RATE / 100 };
    expect(goertzelPower(buffer.left, 3000, window)).toBeGreaterThan(
      goertzelPower(buffer.left, 1500, window) * 100
    );
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(tick, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
