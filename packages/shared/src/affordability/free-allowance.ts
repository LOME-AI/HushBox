/**
 * The free tier's daily allowance as an amount.
 *
 * The allowance is declared in cents, and every surface that wants it as money
 * has to convert. That conversion is the thing worth publishing: a caller doing
 * it inline writes a second cents-to-nano implementation beside
 * `centsToNanoUsd` in `packages/shared/src/affordability/money/nano-usd.ts`, and the
 * two drift the day the unit does.
 *
 * The figure is day-keyed and never reset by a job (`docs/CODE-RULES.md`
 * §Money & Settlement), so this answers what one day's allowance IS, never how
 * much of it is left — that is a served figure and belongs to the funding read.
 */

import { NANO_USD_PER_CENT, nanoUSD } from './money/nano-usd.ts';
import { FREE_ALLOWANCE_CENTS_VALUE } from './money/tiers.ts';
import type { NanoUSD } from './money/nano-usd.ts';

export function freeDailyAllowanceNanoUsd(): NanoUSD {
  return nanoUSD(BigInt(FREE_ALLOWANCE_CENTS_VALUE) * NANO_USD_PER_CENT);
}
