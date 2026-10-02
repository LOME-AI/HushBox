import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { bandShare, itKeepsTheSfxContract } from './sfx-test-support.js';
import { snuff } from './snuff.js';

describe('snuff', () => {
  itKeepsTheSfxContract(snuff, { raw: {}, anchor: 'start' });

  itHoldsBounds(snuff, [
    { key: 'toneHz', accepted: 300, refused: nextAfter(300, -1) },
    { key: 'toneHz', accepted: 3000, refused: nextAfter(3000, 1) },
    { key: 'decay', accepted: 0.05, refused: nextAfter(0.05, -1) },
    { key: 'decay', accepted: 1, refused: nextAfter(1, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(snuff, { decay: 0.234_56 });
    expect(buffer.left).toHaveLength(Math.round(0.234_56 * SAMPLE_RATE));
  });

  it('darkens as it fades', () => {
    const { buffer } = renderWith(snuff, { toneHz: 1000, decay: 0.5 });
    const bright = { band: { low: 2000, high: 8000 }, rest: { low: 0, high: 2000 } };
    const length = SAMPLE_RATE / 20;
    expect(bandShare(buffer.left, bright, { from: 0, length })).toBeGreaterThan(
      bandShare(buffer.left, bright, { from: SAMPLE_RATE / 5, length }) * 2
    );
  });

  it('breathes across the field', () => {
    const { buffer } = renderWith(snuff, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
