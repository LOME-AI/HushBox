import type { Locator, Page } from '@playwright/test';

/**
 * Sum the dollar values shown in the per-message cost badges, in cents.
 *
 * The badge text format is `$0.0001` (or `0.0001` without a leading `$` on
 * trial messages). Unparseable badges contribute `0`. Used by both the
 * multi-model send tests and the multi-model regenerate tests to assert
 * wallet-debit matches the on-screen sum.
 */
export async function sumDisplayedMessageCostCents(scope: Locator | Page): Promise<number> {
  const costElements = scope.locator('[data-testid="message-cost"]');
  const count = await costElements.count();
  let totalCents = 0;
  for (let index = 0; index < count; index++) {
    const text = (await costElements.nth(index).textContent()) ?? '';
    const match = /\$?([\d.]+)/.exec(text);
    if (match) totalCents += Math.round(Number.parseFloat(match[1] ?? '0') * 100);
  }
  return totalCents;
}
