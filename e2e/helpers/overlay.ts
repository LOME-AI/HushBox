import type { Page } from '@playwright/test';
import { TOUCH_QUERY } from '@hushbox/shared';
import { expect } from './settled-expect.js';

/**
 * Evaluates the touch device media query inside the running page.
 * Mirrors `useIsTouchDevice()` — Playwright device presets with
 * `hasTouch: true` set `(pointer: coarse)` in the browser context.
 */
export async function isTouchDevice(page: Page): Promise<boolean> {
  return page.evaluate((query) => globalThis.matchMedia(query).matches, TOUCH_QUERY);
}

/** Returns the expected overlay variant for the current device context. */
export async function expectedOverlayVariant(page: Page): Promise<'dialog' | 'bottom-sheet'> {
  const isTouch = await isTouchDevice(page);
  return isTouch ? 'bottom-sheet' : 'dialog';
}

/** Clicks the overlay close button. Works for both dialog and bottom sheet. */
export async function closeOverlay(page: Page): Promise<void> {
  await page.locator('[data-slot="overlay-close"]').click();
}

/**
 * Asserts the rendered overlay variant matches the device context:
 * dialog on desktop, bottom-sheet on touch devices.
 */
export async function expectCorrectOverlayVariant(page: Page): Promise<void> {
  const variant = await expectedOverlayVariant(page);
  const content = page.locator('[data-testid="overlay-content"]');
  await expect(content).toHaveAttribute('data-overlay-variant', variant);
}
