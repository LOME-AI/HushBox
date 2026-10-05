import { MOBILE_BREAKPOINT, TEST_IDS } from '@hushbox/shared';
import { expect } from './expect.js';
import type { Locator, Page } from '@playwright/test';

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

/**
 * Asserts the rendered overlay variant matches the page's width. Given `within`, it checks the
 * overlay that holds that element, since another overlay can stay open beneath it; otherwise the
 * page's single overlay.
 */
export async function expectCorrectOverlayVariant(page: Page, within?: Locator): Promise<void> {
  const variant = await expectedOverlayVariant(page);
  const overlays = page.getByTestId(TEST_IDS.overlayContent);
  const content = within === undefined ? overlays : overlays.filter({ has: within });
  await expect(content).toHaveAttribute('data-overlay-variant', variant);
}
