import { describe, expect, it } from 'vitest';

import { hashKey, pick, range } from './rand.js';
import { firstOutputs } from './rand-test-support.js';

/** The first value `rand('films')` yields, as the pinned sequence below states it. */
const FIRST_FILMS_OUTPUT = 0.230_564_574_012_532_83;

describe('hashKey', () => {
  it('returns the FNV-1a offset basis for the empty key', () => {
    expect(hashKey('')).toBe(0x81_1c_9d_c5);
  });

  it('matches the published FNV-1a vector for "a"', () => {
    expect(hashKey('a')).toBe(0xe4_0c_29_2c);
  });

  it('matches the published FNV-1a vector for "foobar"', () => {
    expect(hashKey('foobar')).toBe(0xbf_9c_f9_68);
  });

  it('hashes the UTF-8 bytes of a key', () => {
    // FNV-1a over the two bytes 0xC3 0xA9 that encode U+00E9.
    expect(hashKey('é')).toBe(0x1e_9d_e8_c1);
  });
});

describe('rand', () => {
  it('pins the first five outputs for the key "films"', () => {
    // Computed by an independent reference implementation of FNV-1a and sfc32.
    // A change here changes every seeded value in every film.
    expect(firstOutputs('films', 5)).toEqual([
      FIRST_FILMS_OUTPUT,
      0.583_177_813_095_971_9,
      0.669_044_191_949_069_5,
      0.069_399_358_471_855_52,
      0.514_781_770_063_564_2,
    ]);
  });

  it('returns the same sequence for the same key', () => {
    expect(firstOutputs('ember', 16)).toEqual(firstOutputs('ember', 16));
  });

  it('returns a different sequence for a different key', () => {
    expect(firstOutputs('ember-1', 5)).not.toEqual(firstOutputs('ember-2', 5));
  });
});

describe('range', () => {
  it('scales the first value of a key into [min, max)', () => {
    expect(range('films', 10, 20)).toBe(10 + FIRST_FILMS_OUTPUT * 10);
  });
});

describe('pick', () => {
  it('picks the item the first value of a key indexes', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(pick('films', items)).toBe(items[Math.floor(FIRST_FILMS_OUTPUT * items.length)]);
  });

  it('picks the same item for the same key', () => {
    expect(pick('ember', ['a', 'b', 'c'])).toBe(pick('ember', ['a', 'b', 'c']));
  });

  it('throws naming the key when there is nothing to pick', () => {
    expect(() => pick('empty-choice', [])).toThrow(/empty-choice/);
  });
});
