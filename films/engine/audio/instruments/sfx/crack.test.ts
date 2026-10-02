import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { crack } from './crack.js';
import { itKeepsTheSfxContract } from './sfx-test-support.js';

describe('crack', () => {
  itKeepsTheSfxContract(crack, { raw: {}, anchor: 'start' });

  itHoldsBounds(crack, [
    { key: 'toneHz', accepted: 500, refused: nextAfter(500, -1) },
    { key: 'toneHz', accepted: 5000, refused: nextAfter(5000, 1) },
    { key: 'decay', accepted: 0.03, refused: nextAfter(0.03, -1) },
    { key: 'decay', accepted: 0.8, refused: nextAfter(0.8, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(crack, { decay: 0.123_45 });
    expect(buffer.left).toHaveLength(Math.round(0.123_45 * SAMPLE_RATE));
  });

  it('is brittle: far more energy above 1 kHz than below 200 Hz', () => {
    const { buffer } = renderWith(crack, {});
    const window = { from: 0, length: SAMPLE_RATE / 20 };
    expect(bandPower(buffer.left, { low: 1000, high: 10_000 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 0, high: 200 }, window) * 100
    );
  });

  it('scatters its splinters across the field', () => {
    const { buffer } = renderWith(crack, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
