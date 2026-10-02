/**
 * The wire codec is lossless over every amount it admits: formatting a bigint
 * for a JSON boundary and parsing it back returns the same bigint.
 *
 * Amounts are drawn as bigints rather than as numbers converted afterwards. A
 * number-shaped generator reaches only the magnitudes a `number` can hold, so
 * it could never produce the amount a `Number()` hop inside the codec would
 * silently truncate — the bigint draw is what puts that defect in reach.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nanoUSD, parseNanoUSD, serializeNanoUSD } from './nano-usd.ts';

/**
 * Every bigint is a valid amount, so nothing narrows the draw: the library's
 * own default width bounds it, and its boundary bias supplies zero, ±1, both
 * ends of that width, and magnitudes past `Number.MAX_SAFE_INTEGER`.
 */
const amounts = fc.bigInt();

describe('the nano-USD wire codec', () => {
  it('parses back every amount it formats', () => {
    fc.assert(
      fc.property(amounts, (amount) => {
        expect(parseNanoUSD(serializeNanoUSD(nanoUSD(amount)))).toBe(amount);
      })
    );
  });
});
