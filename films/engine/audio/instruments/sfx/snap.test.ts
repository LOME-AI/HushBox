import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { itKeepsTheSfxContract } from './sfx-test-support.js';
import { snap } from './snap.js';

describe('snap', () => {
  itKeepsTheSfxContract(snap, { raw: {}, anchor: 'start' });

  itHoldsBounds(snap, [
    { key: 'toneHz', accepted: 800, refused: nextAfter(800, -1) },
    { key: 'toneHz', accepted: 4000, refused: nextAfter(4000, 1) },
    { key: 'decay', accepted: 0.02, refused: nextAfter(0.02, -1) },
    { key: 'decay', accepted: 0.3, refused: nextAfter(0.3, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(snap, { decay: 0.067_89 });
    expect(buffer.left).toHaveLength(Math.round(0.067_89 * SAMPLE_RATE));
  });

  it('cracks above 1 kHz far louder than it thumps below 200 Hz', () => {
    const { buffer } = renderWith(snap, { decay: 0.1 });
    const window = { from: 0, length: SAMPLE_RATE / 50 };
    expect(bandPower(buffer.left, { low: 1000, high: 8000 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 0, high: 200 }, window) * 10
    );
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(snap, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
