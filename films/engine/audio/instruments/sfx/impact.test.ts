import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { goertzelPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { impact } from './impact.js';
import { bandShare, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('impact', () => {
  itKeepsTheSfxContract(impact, { raw: {}, anchor: 'start' });

  itHoldsBounds(impact, [
    { key: 'decay', accepted: 0.3, refused: nextAfter(0.3, -1) },
    { key: 'decay', accepted: 6, refused: nextAfter(6, 1) },
    { key: 'subHz', accepted: 20, refused: nextAfter(20, -1) },
    { key: 'subHz', accepted: 60, refused: nextAfter(60, 1) },
    { key: 'drive', accepted: 0.5, refused: nextAfter(0.5, -1) },
    { key: 'drive', accepted: 8, refused: nextAfter(8, 1) },
    { key: 'metal', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'metal', accepted: 1, refused: nextAfter(1, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(impact, { decay: 0.456_78 });
    expect(buffer.left).toHaveLength(Math.round(0.456_78 * SAMPLE_RATE));
  });

  it('drops its sub onto its sub frequency', () => {
    const { buffer } = renderWith(impact, { decay: 3, subHz: 32, metal: 0 });
    // Half a second from 1.2 s: 2 Hz bins, 32 Hz on one, 48 Hz between its harmonics.
    const window = { from: (6 * SAMPLE_RATE) / 5, length: SAMPLE_RATE / 2 };
    expect(goertzelPower(buffer.left, 32, window)).toBeGreaterThan(
      goertzelPower(buffer.left, 48, window) * 100
    );
  });

  it('rings metal above 2 kHz into its tail as its metal parameter asks', () => {
    const window = { from: (3 * SAMPLE_RATE) / 10, length: SAMPLE_RATE / 10 };
    const bright = { band: { low: 2000, high: 10_000 }, rest: { low: 0, high: 2000 } };
    const brightShare = (metal: number): number =>
      bandShare(renderWith(impact, { metal }).buffer.left, bright, window);
    expect(brightShare(1)).toBeGreaterThan(brightShare(0) * 10);
  });

  it('strikes its debris above 1 kHz in its first hundredth of a second', () => {
    const { buffer } = renderWith(impact, { metal: 0 });
    const bright = { band: { low: 1000, high: 16_000 }, rest: { low: 0, high: 1000 } };
    expect(bandShare(buffer.left, bright, { from: 0, length: SAMPLE_RATE / 100 })).toBeGreaterThan(
      0.005
    );
  });

  it('thuds near 55 Hz while its sub is still falling towards 20 Hz', () => {
    const { buffer } = renderWith(impact, { metal: 0, subHz: 20 });
    // A tenth of a second from 50 ms: 10 Hz bins; the sub is still above 30 Hz there.
    const window = { from: SAMPLE_RATE / 20, length: SAMPLE_RATE / 10 };
    expect(goertzelPower(buffer.left, 55, window)).toBeGreaterThan(
      goertzelPower(buffer.left, 80, window) * 8
    );
  });

  it('spreads its metal across the field', () => {
    const { buffer } = renderWith(impact, { metal: 1 });
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });

  it('keeps its body in the middle of the field without metal', () => {
    const { buffer } = renderWith(impact, { metal: 0 });
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
