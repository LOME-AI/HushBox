import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import {
  anchorsOnItsLoudnessPeak,
  centroid,
  energy,
  itKeepsTheSfxContract,
} from './sfx-test-support.js';
import { whoosh } from './whoosh.js';

describe('whoosh', () => {
  itKeepsTheSfxContract(whoosh, { raw: {}, anchor: 'peak' });

  itHoldsBounds(whoosh, [
    { key: 'seconds', accepted: 0.1, refused: nextAfter(0.1, -1) },
    { key: 'seconds', accepted: 4, refused: nextAfter(4, 1) },
    { key: 'semitones', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'semitones', accepted: 12, refused: nextAfter(12, 1) },
  ]);

  it.each([0.1, 2])(
    'lands its cue on the peak of its loudness averaged over sixteen seeds at %f s',
    (seconds) => {
      expect(anchorsOnItsLoudnessPeak((key) => renderWith(whoosh, { seconds }, { key }))).toBe(
        true
      );
    }
  );

  it('refuses a direction it does not have', () => {
    expect(whoosh.params.safeParse({ direction: 'up' }).success).toBe(false);
  });

  it('lasts its seconds, to the nearest sample', () => {
    const { buffer } = renderWith(whoosh, { seconds: 0.654_32 });
    expect(buffer.left).toHaveLength(Math.round(0.654_32 * SAMPLE_RATE));
  });

  it('passes by in its middle: its middle fifth far louder than its first or last', () => {
    const { buffer } = renderWith(whoosh, { seconds: 1 });
    const fifth = SAMPLE_RATE / 5;
    const middle = energy(buffer.left.subarray(2 * fifth, 3 * fifth));
    expect(middle).toBeGreaterThan(energy(buffer.left.subarray(0, fifth)) * 10);
    expect(middle).toBeGreaterThan(energy(buffer.left.subarray(4 * fifth)) * 10);
  });

  it('pans from left to right unless told otherwise', () => {
    const { buffer } = renderWith(whoosh, { seconds: 1 });
    const third = Math.floor(SAMPLE_RATE / 3);
    expect(energy(buffer.left.subarray(0, third))).toBeGreaterThan(
      energy(buffer.right.subarray(0, third)) * 2
    );
    expect(energy(buffer.right.subarray(2 * third))).toBeGreaterThan(
      energy(buffer.left.subarray(2 * third)) * 2
    );
  });

  it('pans from right to left when told to', () => {
    const { buffer } = renderWith(whoosh, { seconds: 1, direction: 'rightToLeft' });
    const third = Math.floor(SAMPLE_RATE / 3);
    expect(energy(buffer.right.subarray(0, third))).toBeGreaterThan(
      energy(buffer.left.subarray(0, third)) * 2
    );
  });

  it('falls in pitch through the pass-by, by Doppler', () => {
    const { buffer } = renderWith(whoosh, { seconds: 1, semitones: 12 });
    // Symmetric about the middle, where the band's centre is the same.
    const length = SAMPLE_RATE / 10;
    const approaching = centroid(buffer.left, { from: (3 * SAMPLE_RATE) / 10, length });
    const receding = centroid(buffer.left, { from: (6 * SAMPLE_RATE) / 10, length });
    expect(approaching).toBeGreaterThan(receding * 1.2);
  });
});
