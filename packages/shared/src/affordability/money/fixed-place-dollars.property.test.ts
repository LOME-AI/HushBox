/**
 * The fixed-place dollar formatters round exactly: over every nano-USD amount
 * each agrees with a rational half-up reference, and wherever a double still
 * holds the amount to the nano, each agrees with `toFixed` at its place count on
 * every amount that is not an exact half.
 *
 * Amounts are drawn as bigints, never as numbers converted afterwards: a
 * number-shaped draw cannot reach past 2^53, which is where a float hop would
 * silently lose the low digits.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  nanoUsdToFourPlaceDollarString,
  nanoUsdToTwoPlaceDollarString,
} from './fixed-place-dollars.ts';
import { nanoUsdToFullDollarString } from './nano-usd.ts';

/** Signed amounts out to ±2^64, past the 2^63 a Postgres bigint holds. */
const amounts = fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n });

/** Every amount whose nine-digit dollar string a double parses back exactly. */
const floatExactAmounts = fc.bigInt({ min: -(2n ** 50n), max: 2n ** 50n });

/**
 * Exact halves of `step` only: a whole number of steps plus half a step, with
 * either sign. A uniform draw over ±2^64 lands on a half once in `step` cases,
 * so the halves get their own generator rather than being left to luck.
 */
function exactHalvesOf(step: bigint): fc.Arbitrary<bigint> {
  return fc
    .tuple(fc.bigInt({ min: 0n, max: 2n ** 64n / step }), fc.boolean())
    .map(([steps, negative]) => {
      const magnitude = steps * step + step / 2n;
      return negative ? -magnitude : magnitude;
    });
}

/**
 * The rational reference: amount / 10^9 dollars rounded to `places`, half away
 * from zero, computed as floor((2|a| + step) / 2·step) — the closed form of
 * rounding |a| / step to the nearest integer with halves going up.
 */
function halfUpReference(amount: bigint, step: bigint, places: number): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const units = (2n * magnitude + step) / (2n * step);
  const digits = units.toString().padStart(places + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

function isExactHalfOf(amount: bigint, step: bigint): boolean {
  const remainder = amount % step;
  return remainder === step / 2n || remainder === -step / 2n;
}

const FORMATTERS = [
  { name: 'nanoUsdToFourPlaceDollarString', format: nanoUsdToFourPlaceDollarString, places: 4 },
  { name: 'nanoUsdToTwoPlaceDollarString', format: nanoUsdToTwoPlaceDollarString, places: 2 },
] as const;

for (const { name, format, places } of FORMATTERS) {
  /** Nano-USD in one unit of the formatter's last place. */
  const step = 10n ** BigInt(9 - places);

  describe(name, () => {
    it('matches the rational half-up reference on every amount', () => {
      fc.assert(
        fc.property(fc.oneof(amounts, exactHalvesOf(step)), (amount) => {
          expect(format(amount)).toBe(halfUpReference(amount, step, places));
        })
      );
    });

    it('renders every amount that is not an exact half as toFixed does', () => {
      fc.assert(
        fc.property(
          floatExactAmounts.filter((amount) => !isExactHalfOf(amount, step)),
          (amount) => {
            const floatDisplay = Number(nanoUsdToFullDollarString(amount.toString())).toFixed(
              places
            );
            expect(format(amount)).toBe(floatDisplay);
          }
        )
      );
    });
  });
}
