import { isMobileWidth, TEST_IDS } from '@hushbox/shared';
import { expect } from './expect.js';
import type { Page } from '@playwright/test';

/**
 * Opens the marketing landing-page mobile nav drawer if the current viewport
 * is mobile-width. Mirrors `SidebarPage.openMobileSidebarIfNeeded` in
 * pages/sidebar.page.ts but targets the Astro `SiteHeader` mobile button.
 *
 * The header splits at 768 wide: from 768 the full nav shows and this is a
 * no-op; below 768 the full nav is hidden and the menu button shows, so
 * selecting a link inside the full nav would resolve a non-visible element
 * and time out. From 768 the header also falls back to the menu button when
 * the full nav does not fit its row, which only the accessibility widget's
 * larger text or wider faces cause; the specs run at the default text size.
 */
export async function openMobileLandingMenuIfNeeded(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null || !isMobileWidth(viewport.width)) return;

  await page.getByTestId(TEST_IDS.landingMenuToggle).click();
  await expect(page.getByTestId(TEST_IDS.landingMobileMenu)).toBeVisible();
}
