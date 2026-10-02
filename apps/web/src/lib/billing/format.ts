import { nanoUsdToDollarString } from '@hushbox/shared';

/**
 * Attaches the currency symbol to an already-rounded, bare dollar string with
 * the sign ahead of it (`-$1.50`), because a negative amount is a legal state.
 * Every money figure on screen places the sign this way, and the rule has one
 * implementation: a caller holding a nano-USD wire string goes through
 * {@link formatBalance}, while the usage charts call this directly, since
 * recharts hands a `valueFormatter` the plotted dollar number rather than the
 * wire string.
 */
export function applyDollarSign(dollars: string): string {
  return dollars.startsWith('-') ? `-$${dollars.slice(1)}` : `$${dollars}`;
}

/**
 * A wallet balance for display, from its canonical NanoUSD wire string: `$X.XX`
 * with the sign ahead of the currency symbol (`-$0.50`), since a negative
 * balance is a legal state. The cent math belongs to `nanoUsdToDollarString`
 * and is never re-derived here — money is bigint and is not coerced to a float
 * on the way to the screen.
 */
export function formatBalance(wireNanoUsd: string): string {
  return applyDollarSign(nanoUsdToDollarString(wireNanoUsd));
}
