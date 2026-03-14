import { type Page, expect } from '@playwright/test';

/**
 * Wait for a condition to become true, failing fast if the app settles
 * (no in-flight operations) without the condition being met.
 *
 * The app exposes `data-settled="true"` when all TanStack Query fetches,
 * mutations, and SSE streams have completed (with 300ms debounce).
 * If the app settles and the condition still isn't met, it never will be.
 */
export async function waitForConditionOrSettle(
  page: Page,
  condition: () => Promise<boolean>,
  options: { timeout: number; errorMessage: string }
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await condition()) return true;
        const settled = await page
          .locator('[data-settled="true"]')
          .isVisible()
          .catch(() => false);
        if (settled) throw new Error(options.errorMessage);
        return false;
      },
      {
        timeout: options.timeout,
        intervals: [200, 500, 1000],
        message: options.errorMessage,
      }
    )
    .toBe(true);
}
