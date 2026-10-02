import { adminPreviewPath } from '@hushbox/shared';
import type { Page } from '@playwright/test';

/**
 * Open the marketing copy the admin origin serves for `sitePath`, at the very
 * URL the click overlay frames it by.
 *
 * It is a static asset on the admin origin, so it needs no admin API call and
 * no assertion header of its own: the suite is already inside the origin the
 * dev-token flow admits, and what this proves is that the copy is there and
 * the origin's headers let it be framed.
 *
 * The URL comes from the shared derivation rather than being spelled here, so
 * this drives the form the overlay drives. Spelled separately, it would keep
 * passing against a form the overlay does not use.
 */
export async function openMarketingPreview(page: Page, sitePath: string): Promise<void> {
  await page.goto(adminPreviewPath(sitePath));
}
