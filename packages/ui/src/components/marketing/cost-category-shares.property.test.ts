/**
 * The three approximate labels add to 100 for every deposit, whatever the
 * characters stored. The list and the ring both print these labels, so a set
 * that summed to 99 or 101 would show on both surfaces at once.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_RUNS, PROPERTY_TEST_SEED } from '@hushbox/shared/property-tests';
import { costCategoryShares } from './cost-category-shares';

/**
 * Any positive, finite deposit in dollars, from a cent to ten million. The
 * library's boundary bias draws both ends, so the smallest deposit, where
 * storage dwarfs every other share, is reached as well as the middle.
 */
const deposits = fc.double({ min: 0.01, max: 10_000_000, noNaN: true, noDefaultInfinity: true });

/** Characters stored, from none to a billion: storage from $0 to $300. */
const characterCounts = fc.integer({ min: 0, max: 1_000_000_000 });

describe('costCategoryShares labels', () => {
  // This package's runner does not load the shared property-test setup, so the
  // pinned seed and count are passed here rather than inherited.
  const settings = { seed: PROPERTY_TEST_SEED, numRuns: PROPERTY_TEST_RUNS };

  it('sum to 100 for any deposit', () => {
    fc.assert(
      fc.property(deposits, characterCounts, (deposit, characters) => {
        const labels = costCategoryShares(deposit, characters).categories.map(
          (category) => category.roundedPercentage
        );
        expect(labels.reduce((sum, label) => sum + label, 0)).toBe(100);
      }),
      settings
    );
  });
});
