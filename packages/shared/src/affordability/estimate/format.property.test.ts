/**
 * The compact per-1k form is a respelling of the spaced range, never a second
 * rendering: for every pair of billable bounds it carries exactly the two
 * figures `nanoPriceRangePer1k` prints, in the same order. A compact form that
 * rounded, truncated or reordered a bound would show a price the range does
 * not.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nanoPriceRangePer1k, nanoRateCompactPer1k } from './format.ts';

/**
 * A billable per-token rate in nano-USD, drawn so zero and one come up as
 * often as the library's own width: the stripped-zero rendering gives way at
 * the floor, not in the middle of the range.
 */
const billableRate = fc.oneof(fc.constantFrom(0n, 1n), fc.bigInt({ min: 0n }));

const COMPACT_RANGE = /^\$([\d.]+)–([\d.]+)\/1k$/;
const SPACED_RANGE = /^\$([\d.]+) – \$([\d.]+) \/ 1k$/;

function figuresOf(rendered: string, shape: RegExp): readonly string[] {
  const match = shape.exec(rendered);
  if (match === null) throw new Error(`"${rendered}" does not match ${shape.source}`);
  return match.slice(1);
}

describe('nanoRateCompactPer1k', () => {
  it('carries the same two figures as the spaced range for every pair of bounds', () => {
    fc.assert(
      fc.property(billableRate, billableRate, (min, max) => {
        expect(figuresOf(nanoRateCompactPer1k(min, max), COMPACT_RANGE)).toEqual(
          figuresOf(nanoPriceRangePer1k(min, max), SPACED_RANGE)
        );
      })
    );
  });
});
