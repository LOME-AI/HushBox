import type { Locator, Page } from '@playwright/test';

/**
 * Sum the dollar values shown in the per-message cost badges, in micros
 * (millionths of a dollar). Sub-cent costs (e.g. $0.00009201 = ~92 micros)
 * survive the conversion — rounding to cents collapses them to 0 and silently
 * breaks single-tile assertions. The legacy 1-cent tolerance translates to
 * `DISPLAY_COST_TOLERANCE_MICROS` for callers comparing against wallet debit.
 *
 * The badge text format is `$0.0001` (or `0.0001` without a leading `$` on
 * trial messages). Unparseable badges contribute `0`.
 */
export async function sumDisplayedMessageCostMicros(scope: Locator | Page): Promise<number> {
  const costElements = scope.locator('[data-testid="message-cost"]');
  const count = await costElements.count();
  let totalMicros = 0;
  for (let index = 0; index < count; index++) {
    const text = (await costElements.nth(index).textContent()) ?? '';
    const match = /\$?([\d.]+)/.exec(text);
    if (match) totalMicros += Math.round(Number.parseFloat(match[1] ?? '0') * 1_000_000);
  }
  return totalMicros;
}

/**
 * Tolerance for wallet-debit vs displayed-sum assertions. Equivalent to the
 * old 1-cent window, expressed in micros (1¢ = 10_000 micros).
 */
export const DISPLAY_COST_TOLERANCE_MICROS = 10_000;
