import { MOBILE_BREAKPOINT, TEST_IDS } from '@hushbox/shared';
import { expect } from './expect.js';
import type { Page } from '@playwright/test';

/**
 * The overlay variant the page's width gives, whatever the pointer: `Overlay` presents as a
 * bottom sheet below the mobile breakpoint and as a dialog from it.
 */
async function expectedOverlayVariant(page: Page): Promise<'dialog' | 'bottom-sheet'> {
  const width = await page.evaluate(() => globalThis.innerWidth);
  return width < MOBILE_BREAKPOINT ? 'bottom-sheet' : 'dialog';
}

/** Clicks the overlay close button. Works for both dialog and bottom sheet. */
export async function closeOverlay(page: Page): Promise<void> {
  await page.locator('[data-slot="overlay-close"]').click();
}

/** Asserts the rendered overlay variant matches the page's width. */
export async function expectCorrectOverlayVariant(page: Page): Promise<void> {
  const variant = await expectedOverlayVariant(page);
  const content = page.getByTestId(TEST_IDS.overlayContent);
  await expect(content).toHaveAttribute('data-overlay-variant', variant);
}
