import { z } from 'zod';

/**
 * Money is integer nano-USD `bigint` everywhere; it crosses JSON boundaries
 * only as a canonical decimal string (no exponent, no leading zeros, no
 * `-0`). `Number()` coercion on money is forbidden — 2^53 truncates
 * house-account aggregates silently.
 */
const CANONICAL_DECIMAL_PATTERN = /^(?:0|-?[1-9]\d*)$/;

/**
 * Zod schema for the JSON boundary: accepts a canonical decimal string,
 * outputs a branded bigint. The wire format is string-only by design.
 */
export const NanoUSD = z
  .string()
  .regex(CANONICAL_DECIMAL_PATTERN, 'NanoUSD must be a canonical decimal string')
  .transform(BigInt)
  .brand<'NanoUSD'>();

/** Branded bigint: nano-USD (1e-9 USD) integer amounts. */
export type NanoUSD = z.infer<typeof NanoUSD>;

/** Brands a raw bigint as NanoUSD. Every bigint is a valid amount. */
export function nanoUSD(value: bigint): NanoUSD {
  return value as NanoUSD;
}

/** Serializes for a JSON boundary: canonical decimal string. */
export function serializeNanoUSD(value: NanoUSD): string {
  return value.toString(10);
}

/** Parses a JSON-boundary string; throws ZodError on non-canonical input. */
export function parseNanoUSD(value: string): NanoUSD {
  return NanoUSD.parse(value);
}

/** Nano-USD (1e-9 USD) in one integer cent (1e-2 USD). */
export const NANO_USD_PER_CENT = 10_000_000n;

/** Nano-USD (1e-9 USD) in one whole dollar. */
export const NANO_USD_PER_DOLLAR = 1_000_000_000n;

/**
 * A bare, signed dollar string (no `$`) from a canonical NanoUSD wire string,
 * carrying full nano precision (nine fractional digits) via integer bigint math
 * so no float rounding is introduced. Unlike `nanoUsdToDollarString` (which
 * truncates to whole cents), this preserves sub-cent amounts so a small settled
 * cost does not collapse to `0.00`. Callers add their own `$` / display
 * rounding (see `formatNanoUsdCost`).
 */
export function nanoUsdToFullDollarString(wire: string): string {
  const value = parseNanoUSD(wire);
  const negative = value < 0n;
  // Unbrand before negating: unary minus on the branded NanoUSD is lint-unsafe.
  const magnitude = negative ? -BigInt(value) : BigInt(value);
  const dollars = magnitude / NANO_USD_PER_DOLLAR;
  const fraction = magnitude % NANO_USD_PER_DOLLAR;
  return `${negative ? '-' : ''}${dollars.toString()}.${fraction.toString().padStart(9, '0')}`;
}

/**
 * The shapes {@link dollarsToCents} can price exactly: optional leading
 * whitespace, an optional `+`, digits, and at most one dot followed by at most
 * two fraction digits — with nothing after them. Outside it the halves either
 * do not parse at all (`5e2`, `50abc`, `5 0`) or name an amount no whole cent
 * can hold: a whitespace character occupying a fraction slot (`'5.5\n'` reads
 * $5.50), or a third fraction digit (`'5.999'`), which can only be priced by
 * discarding it. The two-digit bound is on the format, not on the digits — a
 * third digit of zero is refused too, so priceability never depends on which
 * precision a particular string happens to waste.
 *
 * A float parse cannot stand in for it: `Number.parseFloat` stops at the first
 * character it cannot read, so it accepts every one of those.
 */
export const PRICEABLE_AMOUNT = /^\s*(\+?\d+(\.\d{0,2})?|\.\d{1,2})$/;

/**
 * Whole cents from a bare `X`/`X.XX` dollar string, using integer bigint math
 * so no float rounding is introduced. Refuses anything {@link PRICEABLE_AMOUNT}
 * rejects, so a caller never receives an amount other than the one its text
 * names — money fails fast rather than degrading to a wrong figure. Nothing is
 * discarded: the grammar admits at most two fraction digits, so the pad-and-
 * slice below only ever pads a short fraction out to a whole cent.
 */
export function dollarsToCents(dollars: string): number {
  if (!PRICEABLE_AMOUNT.test(dollars)) {
    throw new Error('Dollar string cannot be priced exactly');
  }
  const [whole = '0', fraction = ''] = dollars.split('.');
  const wholeDigits = whole.length > 0 ? whole : '0';
  const cents = BigInt(wholeDigits) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return Number(cents);
}

/** Canonical NanoUSD wire string from whole cents (1 cent = 10^7 nano-USD). */
export function centsToNanoUsd(cents: number): string {
  return (BigInt(cents) * NANO_USD_PER_CENT).toString();
}

/**
 * Canonical NanoUSD wire string from a bare `X`/`X.XX` dollar string, via exact
 * integer cent math (never `parseFloat` on a billed amount). Shape and
 * precision are {@link dollarsToCents}'s own refusal, not a caller obligation;
 * a caller still applies its own bounds before charging.
 */
export function dollarsToNanoUsd(dollars: string): string {
  return centsToNanoUsd(dollarsToCents(dollars));
}

/**
 * Whole cents (integer, truncated toward zero) from a canonical NanoUSD wire
 * string. Negative-capable. Display and test-assertion conversion only — all
 * billing math is exact nano-USD bigint; the `Number()` coercion is on the
 * already-divided cent value, never the full nano amount. Sub-cent precision
 * is dropped.
 */
export function nanoUsdToCents(wire: string): number {
  return Number(parseNanoUSD(wire) / NANO_USD_PER_CENT);
}

/**
 * A bare, signed `X.XX` dollar string (no `$`) from a canonical NanoUSD wire
 * string, computed with integer bigint math so no float rounding is introduced.
 * Sub-cent precision is truncated (display only). Callers add their own `$`.
 */
export function nanoUsdToDollarString(wire: string): string {
  const value = parseNanoUSD(wire);
  const negative = value < 0n;
  // Unbrand before negating: unary minus on the branded NanoUSD is lint-unsafe.
  const magnitude = negative ? -BigInt(value) : BigInt(value);
  const cents = magnitude / NANO_USD_PER_CENT;
  const dollars = cents / 100n;
  const remainder = cents % 100n;
  return `${negative ? '-' : ''}${dollars.toString()}.${remainder.toString().padStart(2, '0')}`;
}
