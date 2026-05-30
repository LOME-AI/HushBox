import { isMobileWidth } from '@hushbox/shared';
import { expect } from './settled-expect.js';
import type { Page } from '@playwright/test';

/**
 * Opens the marketing landing-page mobile nav drawer if the current viewport
 * is mobile-width. Mirrors `SidebarPage.openMobileSidebarIfNeeded` in
 * pages/sidebar.page.ts but targets the Astro `LandingHeader` mobile button.
 *
 * On desktop viewports the desktop nav is already visible and this is a no-op.
 * On mobile viewports the desktop nav is `hidden` (Tailwind `md:flex` /
 * `md:hidden` siblings) so selecting a link inside it would resolve a
 * non-visible element and time out.
 */
export async function openMobileLandingMenuIfNeeded(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null || !isMobileWidth(viewport.width)) return;

  await page.getByTestId('landing-menu-toggle').click();
  await expect(page.getByTestId('landing-mobile-menu')).toBeVisible();
}
