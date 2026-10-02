import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { TEST_FRAMES_PER_BEAT, itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { fireRoar } from './fire-roar.js';
import { bandShare, energy, itKeepsTheSfxContract, windowAt, within } from './sfx-test-support.js';

import type { Window } from '../../dsp/dsp-test-support.js';

/** A tenth of a second from `seconds` in. */
const tenth = (seconds: number): Window => windowAt(seconds, SAMPLE_RATE / 10);

/** The share of a second's energy above 3 kHz, one second into a bed with `crackle` crackles per second. */
function brightShare(crackle: number): number {
  const { left } = renderWith(fireRoar, { beats: 8, crackle }).buffer;
  const bands = { band: { low: 3000, high: 16_000 }, rest: { low: 20, high: 3000 } };
  return bandShare(left, bands, { from: SAMPLE_RATE, length: SAMPLE_RATE });
}

describe('fireRoar', () => {
  itKeepsTheSfxContract(fireRoar, { raw: {}, anchor: 'start' });

  itHoldsBounds(fireRoar, [
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 1024, refused: nextAfter(1024, 1), framesPerBeat: 1 },
    { key: 'attack', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'attack', accepted: 30, refused: nextAfter(30, 1) },
    { key: 'release', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'release', accepted: 30, refused: nextAfter(30, 1) },
    { key: 'crackle', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'crackle', accepted: 60, refused: nextAfter(60, 1) },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(fireRoar, { beats: 4 });
    expect(buffer.left).toHaveLength(4 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('swells in over its attack', () => {
    const { buffer } = renderWith(fireRoar, { beats: 10, attack: 2, release: 0.5 });
    expect(energy(within(buffer.left, tenth(0)))).toBeLessThan(
      energy(within(buffer.left, tenth(2))) / 4
    );
  });

  it('roars low: without crackles, more energy below 500 Hz than above 3 kHz', () => {
    const { buffer } = renderWith(fireRoar, { beats: 8, crackle: 0 });
    const window = tenth(1.5);
    expect(bandPower(buffer.left, { low: 20, high: 500 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 3000, high: 16_000 }, window) * 4
    );
  });

  it('crackles: its crackles brighten it above 3 kHz', () => {
    expect(brightShare(60)).toBeGreaterThan(brightShare(0) * 2);
  });

  it('spreads across the field', () => {
    const { buffer } = renderWith(fireRoar, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
