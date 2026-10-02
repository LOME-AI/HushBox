import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { goertzelPower, nextAfter } from '../dsp/dsp-test-support.js';

import { fmBell } from './fm-bell.js';
import { itHoldsBounds, itKeepsTheContract, renderWith } from './instrument-test-support.js';

/** A tenth of a second; 440 Hz and its sidebands 616 Hz apart are all multiples of 10 Hz. */
const LENGTH = SAMPLE_RATE / 10;
/** The modulator's frequency for A4: 1.4 times the carrier. */
const SIDEBAND = 440 + 440 * 1.4;

describe('fmBell', () => {
  itKeepsTheContract(fmBell, { raw: {} });

  itHoldsBounds(fmBell, [
    { key: 'note', accepted: 48, refused: 47 },
    { key: 'note', accepted: 84, refused: 85 },
    { key: 'decay', accepted: 0.1, refused: nextAfter(0.1, -1) },
    { key: 'decay', accepted: 8, refused: nextAfter(8, 1) },
  ]);

  it('refuses a note between semitones', () => {
    expect(fmBell.params.safeParse({ note: 72.5 }).success).toBe(false);
  });

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(fmBell, { decay: 1.234_567 });
    expect(buffer.left).toHaveLength(Math.round(1.234_567 * SAMPLE_RATE));
  });

  it('strikes bright and rings pure', () => {
    const { buffer } = renderWith(fmBell, { note: 69, decay: 3 });
    const brightness = (from: number): number =>
      goertzelPower(buffer.left, SIDEBAND, { from, length: LENGTH }) /
      goertzelPower(buffer.left, 440, { from, length: LENGTH });
    expect(brightness(0)).toBeGreaterThan(brightness(2 * SAMPLE_RATE) * 100);
  });

  it('rings at its note', () => {
    const { buffer } = renderWith(fmBell, { note: 69, decay: 3 });
    const from = 2 * SAMPLE_RATE;
    const note = goertzelPower(buffer.left, 440, { from, length: LENGTH });
    expect(note).toBeGreaterThan(
      goertzelPower(buffer.left, SIDEBAND, { from, length: LENGTH }) * 100
    );
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(fmBell, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
