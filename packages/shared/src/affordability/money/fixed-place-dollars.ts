import { NANO_USD_PER_DOLLAR, parseNanoUSD } from './nano-usd.ts';

/**
 * A bare, signed dollar string (no `$`) with `places` fraction digits, from a
 * nano-USD amount — a bigint or a canonical NanoUSD wire string — rounded
 * half-up (halves away from zero) in integer bigint math, so an exact half
 * never rounds the way a float's binary approximation happens to fall. A
 * negative amount keeps its sign even when it rounds to zero.
 */
function nanoUsdToFixedPlaceDollarString(amount: bigint | string, places: number): string {
  const value = typeof amount === 'string' ? BigInt(parseNanoUSD(amount)) : amount;
  const step = NANO_USD_PER_DOLLAR / 10n ** BigInt(places);
  const unitsPerDollar = NANO_USD_PER_DOLLAR / step;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const roundsUp = (magnitude % step) * 2n >= step;
  const units = magnitude / step + (roundsUp ? 1n : 0n);
  const fraction = (units % unitsPerDollar).toString().padStart(places, '0');
  return `${negative ? '-' : ''}${(units / unitsPerDollar).toString()}.${fraction}`;
}

/** `X.XXXX`: {@link nanoUsdToFixedPlaceDollarString} at four places. Callers add their own `$`. */
export function nanoUsdToFourPlaceDollarString(amount: bigint | string): string {
  return nanoUsdToFixedPlaceDollarString(amount, 4);
}

/** `X.XX`: {@link nanoUsdToFixedPlaceDollarString} at two places. Callers add their own `$`. */
export function nanoUsdToTwoPlaceDollarString(amount: bigint | string): string {
  return nanoUsdToFixedPlaceDollarString(amount, 2);
}
