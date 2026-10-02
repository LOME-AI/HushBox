/**
 * The bake, the port's charge conversion and the routing cap's un-bake close
 * one loop: a rate baked billable once, un-baked into `max_price`, bounds what
 * any endpoint served under that cap can be billed. Whatever the vendor
 * serves at or below the cap, the port's one rounding of its cost never
 * exceeds the baked rate times the tokens. A rate on the 10⁻¹² USD grid,
 * baked and then un-baked, never lands below itself; a finer rate can.
 *
 * Rates are drawn magnitude first: a uniform draw over a range this wide
 * would put nearly every case in its top decades, while the sub-nano rates at
 * the bottom are where rounding decides the bill.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyMarkupCeilFromUsdDecimal } from '@hushbox/shared';
import {
  MARKUP_BASIS_POINTS,
  billableRateToMaxPriceUsdPerMillion,
  providerUsdToBillableNanoUsd,
  roundHalfEvenDiv,
  usdToNanoUsd,
} from './money.js';

/** The most fractional digits of USD a drawn vendor rate carries. */
const VENDOR_FRACTION_DIGITS = 30;

/** The exact-rate grid the un-bake rounds to: 10⁻¹² USD. */
const PICO_FRACTION_DIGITS = 12;

/**
 * The dearest provider rate the charge property draws: 10⁻³ USD a token. At
 * two million tokens that is a two-thousand-dollar cost, where the vendor's
 * float `usage.cost` still resolves to within half a pico.
 */
const MAX_RATE_DECIMAL_EXPONENT = VENDOR_FRACTION_DIGITS - 3;

/** The widest rate the un-bake property draws: 1,000 USD a unit, on the pico grid. */
const MAX_PICO_DECIMAL_EXPONENT = 15;

const MAX_TOKENS = 2_000_000;

function decimalOf(units: bigint, fractionDigits: number): string {
  const digits = units.toString().padStart(fractionDigits + 1, '0');
  return `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
}

function bakedRate(rate: string): bigint {
  const billable = applyMarkupCeilFromUsdDecimal(rate);
  if (billable === undefined) throw new Error(`the generator drew an unparseable rate: ${rate}`);
  return billable;
}

/** The un-bake's USD-per-million string, read back as pico-USD a token. */
function unbakedPico(billable: bigint): bigint {
  return BigInt(billableRateToMaxPriceUsdPerMillion(billable).replace('.', ''));
}

/** An integer count of `10^-digits` USD, its magnitude drawn before its value. */
function magnitudeFirstUnits(maxDecimalExponent: number): fc.Arbitrary<bigint> {
  return fc
    .integer({ min: 0, max: maxDecimalExponent })
    .chain((exponent) => fc.bigInt({ min: 0n, max: 10n ** BigInt(exponent) }));
}

/** The one-token call and the longest call are drawn deliberately, not waited for. */
const tokenCounts = fc.oneof(
  { arbitrary: fc.constantFrom(1, MAX_TOKENS), weight: 1 },
  { arbitrary: fc.integer({ min: 1, max: MAX_TOKENS }), weight: 3 }
);

interface ServedCall {
  readonly billable: bigint;
  readonly tokens: number;
  /** The call's cost as the vendor's float `usage.cost`. */
  readonly costUsd: number;
}

/**
 * A vendor rate with up to thirty fractional digits, its baked billable rate,
 * and a call of 1 to 2,000,000 tokens served at a rate at or below the
 * un-baked cap. The cap itself is drawn deliberately: it is the served rate
 * the bound is tightest at.
 */
const providerRateDecimals: fc.Arbitrary<ServedCall> = fc
  .record({ vendorUnits: magnitudeFirstUnits(MAX_RATE_DECIMAL_EXPONENT), tokens: tokenCounts })
  .chain(({ vendorUnits, tokens }) => {
    const billable = bakedRate(decimalOf(vendorUnits, VENDOR_FRACTION_DIGITS));
    const capUnits =
      unbakedPico(billable) * 10n ** BigInt(VENDOR_FRACTION_DIGITS - PICO_FRACTION_DIGITS);
    return fc
      .oneof(
        { arbitrary: fc.constant(capUnits), weight: 1 },
        { arbitrary: fc.bigInt({ min: 0n, max: capUnits }), weight: 2 }
      )
      .map((servedUnits) => ({
        billable,
        tokens,
        costUsd: Number(decimalOf(servedUnits * BigInt(tokens), VENDOR_FRACTION_DIGITS)),
      }));
  });

interface BakedRate {
  /** The exact provider rate, as an integer count of 10⁻¹² USD. */
  readonly ratePico: bigint;
  readonly billable: bigint;
}

/** A rate on the pico grid and the billable ceiling it bakes to. */
const billableCeilings: fc.Arbitrary<BakedRate> = magnitudeFirstUnits(
  MAX_PICO_DECIMAL_EXPONENT
).map((ratePico) => ({
  ratePico,
  billable: bakedRate(decimalOf(ratePico, PICO_FRACTION_DIGITS)),
}));

function billsWithinTheBakedRate(
  convert: (usd: number) => bigint
): fc.IPropertyWithHooks<[ServedCall]> {
  return fc.property(providerRateDecimals, ({ billable, tokens, costUsd }) => {
    expect(convert(costUsd)).toBeLessThanOrEqual(billable * BigInt(tokens));
  });
}

describe('the bake, the charge conversion and the un-bake', () => {
  it('bill a call served at or below the un-baked cap no more than its baked rate times its tokens', () => {
    fc.assert(billsWithinTheBakedRate(providerUsdToBillableNanoUsd));
  });

  it('bill above the baked rate on some call when the cost is rounded to nano before the markup', () => {
    const retiredTwoRounding = (usd: number): bigint =>
      roundHalfEvenDiv(usdToNanoUsd(usd) * (10_000n + MARKUP_BASIS_POINTS), 10_000n);
    expect(fc.check(billsWithinTheBakedRate(retiredTwoRounding)).failed).toBe(true);
  });

  it('un-bake a baked rate on the 10⁻¹² USD grid to no less than the exact rate it was baked from', () => {
    fc.assert(
      fc.property(billableCeilings, ({ ratePico, billable }) => {
        expect(unbakedPico(billable)).toBeGreaterThanOrEqual(ratePico);
      })
    );
  });

  it('un-bake a baked rate to no more than its billable rate divided by 1.15', () => {
    fc.assert(
      fc.property(billableCeilings, ({ billable }) => {
        expect(unbakedPico(billable) * 115n).toBeLessThanOrEqual(billable * 100_000n);
      })
    );
  });
});
