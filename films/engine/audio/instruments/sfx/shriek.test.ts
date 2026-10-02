import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { centroid, itKeepsTheSfxContract } from './sfx-test-support.js';
import { shriek } from './shriek.js';

/** A tenth of a second from 120 ms: the shriek near the top of its arc, at about its tone. */
const NEAR_THE_TOP = { from: (3 * SAMPLE_RATE) / 25, length: SAMPLE_RATE / 10 };

describe('shriek', () => {
  itKeepsTheSfxContract(shriek, { raw: {}, anchor: 'start' });

  itHoldsBounds(shriek, [
    { key: 'toneHz', accepted: 300, refused: nextAfter(300, -1) },
    { key: 'toneHz', accepted: 3000, refused: nextAfter(3000, 1) },
    { key: 'seconds', accepted: 0.2, refused: nextAfter(0.2, -1) },
    { key: 'seconds', accepted: 4, refused: nextAfter(4, 1) },
  ]);

  it('lasts its seconds, to the nearest sample', () => {
    const { buffer } = renderWith(shriek, { seconds: 0.765_43 });
    expect(buffer.left).toHaveLength(Math.round(0.765_43 * SAMPLE_RATE));
  });

  it('screeches around its tone, with little energy far below it', () => {
    const { buffer } = renderWith(shriek, { toneHz: 1300, seconds: 1 });
    const window = { from: SAMPLE_RATE / 10, length: SAMPLE_RATE / 2 };
    expect(bandPower(buffer.left, { low: 650, high: 4000 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 20, high: 300 }, window) * 10
    );
  });

  it('peaks in pitch early and sags by its end', () => {
    const { buffer } = renderWith(shriek, { toneHz: 1300, seconds: 1 });
    const length = SAMPLE_RATE / 20;
    expect(centroid(buffer.left, { from: SAMPLE_RATE / 5, length })).toBeGreaterThan(
      centroid(buffer.left, { from: (17 * SAMPLE_RATE) / 20, length }) * 1.1
    );
  });

  it('sings through its FM operators around its pitch, below the wind', () => {
    const { buffer } = renderWith(shriek, { toneHz: 1300, seconds: 1 });
    expect(bandPower(buffer.left, { low: 910, high: 1690 }, NEAR_THE_TOP)).toBeGreaterThan(
      bandPower(buffer.left, { low: 2210, high: 2990 }, NEAR_THE_TOP) * 0.8
    );
  });

  it('modulates: sidebands 0.29 of its pitch either side of it outweigh the carrier', () => {
    // At 350 ms of a 2 s shriek at 1 kHz its pitch has just crested near 993 Hz,
    // so the first sidebands sit near 705 Hz and 1281 Hz.
    const { buffer } = renderWith(shriek, { toneHz: 1000, seconds: 2 });
    const window = { from: (7 * SAMPLE_RATE) / 20, length: SAMPLE_RATE / 10 };
    const sidebands =
      bandPower(buffer.left, { low: 610, high: 810 }, window) +
      bandPower(buffer.left, { low: 1190, high: 1390 }, window);
    expect(sidebands).toBeGreaterThan(bandPower(buffer.left, { low: 900, high: 1100 }, window));
  });

  it('howls with filtered wind two to four times above its pitch', () => {
    const { buffer } = renderWith(shriek, { toneHz: 1300, seconds: 1 });
    expect(bandPower(buffer.left, { low: 3250, high: 5200 }, NEAR_THE_TOP)).toBeGreaterThan(
      bandPower(buffer.left, { low: 650, high: 2600 }, NEAR_THE_TOP) * 0.005
    );
  });

  it('spreads across the field', () => {
    const { buffer } = renderWith(shriek, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
