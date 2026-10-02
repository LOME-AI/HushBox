import { describe, expect, it } from 'vitest';

import { rand } from '../../../rand/rand.js';
import { SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, goertzelPower } from '../../dsp/dsp-test-support.js';
import { exponentialDecay, sampleAt } from '../../dsp/index.js';
import { ONSET_LEVEL } from '../instrument-test-support.js';

import { bandShare, energy } from './sfx-test-support.js';
import { fallingSweep, shepardFall } from './sweep.js';

import type { FilterMode } from '../../dsp/index.js';

/** Four seconds under an envelope that barely falls, so level changes are the sweep's own. */
function sweep(
  mode: FilterMode,
  octaves: number,
  key: string
): { left: Float32Array; right: Float32Array } {
  const envelope = exponentialDecay({ samples: 4 * SAMPLE_RATE, t60: 1000 });
  return fallingSweep({ envelope, octaves, mode }, rand(key));
}

const TENTH = SAMPLE_RATE / 10;

describe('fallingSweep', () => {
  it.each(['lowpass', 'bandpass'] as const)(
    'is heard in both channels from its first sample through a %s, whatever the seed',
    (mode) => {
      for (const key of ['a', 'b', 'c', 'd']) {
        const { left, right } = sweep(mode, 2, key);
        const quieter = Math.min(Math.abs(sampleAt(left, 0)), Math.abs(sampleAt(right, 0)));
        expect(quieter).toBeGreaterThan(ONSET_LEVEL);
      }
    }
  );

  it('starts its tone at 1.6 kHz', () => {
    const { left } = sweep('lowpass', 1, 'tone');
    // A hundredth of a second: 100 Hz bins, 1.6 kHz on one.
    const window = { from: 0, length: SAMPLE_RATE / 100 };
    expect(goertzelPower(left, 1600, window)).toBeGreaterThan(
      goertzelPower(left, 1500, window) * 10
    );
  });

  it('falls its tone an octave over its length when asked for one octave', () => {
    const { left } = sweep('lowpass', 1, 'tone');
    const window = { from: left.length - SAMPLE_RATE / 100, length: SAMPLE_RATE / 100 };
    expect(goertzelPower(left, 800, window)).toBeGreaterThan(
      goertzelPower(left, 1600, window) * 10
    );
  });

  it('closes its noise filter as it falls', () => {
    const { left } = sweep('lowpass', 2, 'noise');
    const bright = { band: { low: 3000, high: 16_000 }, rest: { low: 0, high: 3000 } };
    expect(bandShare(left, bright, { from: 0, length: TENTH })).toBeGreaterThan(
      bandShare(left, bright, { from: left.length - TENTH, length: TENTH }) * 10
    );
  });

  it('gives each channel its own noise', () => {
    const { left, right } = sweep('lowpass', 2, 'noise');
    expect([...right]).not.toEqual([...left]);
  });
});

describe('shepardFall', () => {
  /** Eight seconds falling one octave: a quarter octave every two seconds. */
  const layer = shepardFall(8 * SAMPLE_RATE, 1);

  it('starts silent: every partial starts at phase 0', () => {
    expect(layer[0]).toBe(0);
  });

  it('falls: a quarter of the way, a partial sits a quarter octave below 640 Hz, none a quarter above', () => {
    const window = { from: 2 * SAMPLE_RATE - TENTH / 2, length: TENTH };
    // 640 Hz is a partial at the start; 538 Hz and 761 Hz are a quarter octave either side of it.
    expect(goertzelPower(layer, 538, window)).toBeGreaterThan(
      goertzelPower(layer, 761, window) * 1000
    );
  });

  it('holds its level while its partials cross the whole span: every tenth within 5% of the mean', () => {
    // Eight octaves in eight seconds: every partial passes through every weight.
    const crossing = shepardFall(8 * SAMPLE_RATE, 8);
    const tenth = crossing.length / 10;
    const levels = Array.from({ length: 10 }, (_zero, index) =>
      Math.sqrt(energy(crossing.subarray(index * tenth, (index + 1) * tenth)) / tenth)
    );
    const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    for (const level of levels) {
      expect(Math.abs(level / mean - 1)).toBeLessThan(0.05);
    }
  });

  it('re-enters a wrapped partial silently at the top of its span', () => {
    // The lowest partial wraps to the top on its first step down; near 10 kHz it
    // must be all but silent against the partials in the middle of the span.
    const window = { from: 0, length: TENTH };
    expect(bandPower(layer, { low: 7000, high: 12_000 }, window)).toBeLessThan(
      bandPower(layer, { low: 320, high: 1280 }, window) / 100
    );
  });
});
