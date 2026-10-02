import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { itKeepsTheSfxContract } from './sfx-test-support.js';
import { typewriter } from './typewriter.js';

describe('typewriter', () => {
  itKeepsTheSfxContract(typewriter, { raw: {}, anchor: 'start' });

  itHoldsBounds(typewriter, [
    { key: 'toneHz', accepted: 800, refused: nextAfter(800, -1) },
    { key: 'toneHz', accepted: 4000, refused: nextAfter(4000, 1) },
    { key: 'decay', accepted: 0.02, refused: nextAfter(0.02, -1) },
    { key: 'decay', accepted: 0.3, refused: nextAfter(0.3, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(typewriter, { decay: 0.076_54 });
    expect(buffer.left).toHaveLength(Math.round(0.076_54 * SAMPLE_RATE));
  });

  it('knocks around its tone', () => {
    const { buffer } = renderWith(typewriter, { toneHz: 2000, decay: 0.1 });
    const window = { from: 0, length: SAMPLE_RATE / 50 };
    expect(bandPower(buffer.left, { low: 1500, high: 2500 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 5000, high: 6000 }, window) * 4
    );
  });

  it('slaps its type bar a hundredth of a second after the key, bright above 5 kHz', () => {
    const { buffer } = renderWith(typewriter, { decay: 0.1 });
    // The 2 ms either side of the slap at 11 ms.
    const length = SAMPLE_RATE / 500;
    const slap = Math.round(0.011 * SAMPLE_RATE);
    const bright = { low: 5000, high: 15_000 };
    expect(bandPower(buffer.left, bright, { from: slap, length })).toBeGreaterThan(
      bandPower(buffer.left, bright, { from: slap - length, length }) * 3
    );
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(typewriter, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
