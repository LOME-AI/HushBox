import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { glassShatter } from './glass-shatter.js';
import { energy, itKeepsTheSfxContract, within } from './sfx-test-support.js';

describe('glassShatter', () => {
  itKeepsTheSfxContract(glassShatter, { raw: {}, anchor: 'start' });

  itHoldsBounds(glassShatter, [
    { key: 'decay', accepted: 0.3, refused: nextAfter(0.3, -1) },
    { key: 'decay', accepted: 4, refused: nextAfter(4, 1) },
    { key: 'shards', accepted: 8, refused: 7 },
    { key: 'shards', accepted: 200, refused: 201 },
  ]);

  it('refuses a fractional number of shards', () => {
    expect(glassShatter.params.safeParse({ shards: 12.5 }).success).toBe(false);
  });

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(glassShatter, { decay: 0.987_65 });
    expect(buffer.left).toHaveLength(Math.round(0.987_65 * SAMPLE_RATE));
  });

  it('is bright: more energy above 2.5 kHz than below 1 kHz', () => {
    const { buffer } = renderWith(glassShatter, {});
    const window = { from: SAMPLE_RATE / 5, length: SAMPLE_RATE / 5 };
    expect(bandPower(buffer.left, { low: 2500, high: 16_000 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 0, high: 1000 }, window) * 10
    );
  });

  it('breaks with a bright burst: its first hundredth of a second far louder than 40 ms on', () => {
    const { buffer } = renderWith(glassShatter, {});
    const hundredth = SAMPLE_RATE / 100;
    expect(energy(within(buffer.left, { from: 0, length: hundredth }))).toBeGreaterThan(
      energy(within(buffer.left, { from: 4 * hundredth, length: hundredth })) * 4
    );
  });

  it('rings its shards on after the crunch has died', () => {
    const decay = 1.4;
    const { buffer } = renderWith(glassShatter, { decay });
    // The crunch falls 60 dB in 35% of the decay; after that, only shards sound.
    const tail = buffer.left.subarray(Math.round(0.35 * decay * SAMPLE_RATE));
    expect(energy(tail)).toBeGreaterThan(energy(buffer.left) * 1e-3);
  });

  it('scatters its shards across the field', () => {
    const { buffer } = renderWith(glassShatter, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
