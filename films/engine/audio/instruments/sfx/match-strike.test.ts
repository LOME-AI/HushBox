import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { matchStrike } from './match-strike.js';
import { bandShare, energy, itKeepsTheSfxContract, windowAt, within } from './sfx-test-support.js';

import type { Window } from '../../dsp/dsp-test-support.js';

/** A twentieth of a second from `seconds` in. */
const twentieth = (seconds: number): Window => windowAt(seconds, SAMPLE_RATE / 20);

describe('matchStrike', () => {
  itKeepsTheSfxContract(matchStrike, { raw: {}, anchor: 'start' });

  itHoldsBounds(matchStrike, [
    { key: 'seconds', accepted: 0.3, refused: nextAfter(0.3, -1) },
    { key: 'seconds', accepted: 4, refused: nextAfter(4, 1) },
  ]);

  it('lasts its seconds, to the nearest sample', () => {
    const { buffer } = renderWith(matchStrike, { seconds: 0.876_54 });
    expect(buffer.left).toHaveLength(Math.round(0.876_54 * SAMPLE_RATE));
  });

  it('scrapes brighter than it burns: its share above 2 kHz falls once it flares', () => {
    const { buffer } = renderWith(matchStrike, {});
    const bright = { band: { low: 2000, high: 12_000 }, rest: { low: 0, high: 2000 } };
    expect(bandShare(buffer.left, bright, twentieth(0))).toBeGreaterThan(
      bandShare(buffer.left, bright, twentieth(0.2)) * 2
    );
  });

  it('flares louder than it scrapes', () => {
    const { buffer } = renderWith(matchStrike, {});
    expect(energy(within(buffer.left, twentieth(0.1)))).toBeGreaterThan(
      energy(within(buffer.left, twentieth(0)))
    );
  });

  it('burns as noise above 500 Hz once it flares', () => {
    const { buffer } = renderWith(matchStrike, {});
    const burning = { band: { low: 500, high: 8000 }, rest: { low: 20, high: 500 } };
    expect(bandShare(buffer.left, burning, twentieth(0.1))).toBeGreaterThan(0.2);
  });

  it('thumps below 150 Hz as it ignites', () => {
    const { buffer } = renderWith(matchStrike, {});
    const thump = { band: { low: 20, high: 150 }, rest: { low: 150, high: 8000 } };
    expect(bandShare(buffer.left, thump, windowAt(0.06, SAMPLE_RATE / 10))).toBeGreaterThan(0.2);
  });
});
