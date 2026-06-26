import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Locator, Page } from '@playwright/test';
import type { ChatPage } from '../pages/index.js';

/**
 * Hover `message` and click its Share button until the share-message modal is
 * open, returning the modal locator.
 *
 * The Share button is revealed by hover; under host saturation a re-render
 * between the hover and the click (a late decrypt, a presence update) can
 * swallow the React click so the modal never opens — the click lands on the DOM
 * node but its handler runs against a detached fiber. Re-issuing the hover+click
 * recovers it. The first guard short-circuits once the modal is open so a
 * late-but-successful click is never double-issued into the now-covered button
 * (which would dismiss the modal via the overlay).
 */
export async function openShareModalForMessage(page: Page, message: Locator): Promise<Locator> {
  const modal = page.getByTestId(TEST_IDS.shareMessageModal);
  await expect(async () => {
    if (await modal.isVisible()) return;
    await message.hover();
    const shareButton = message.getByRole('button', { name: 'Share' });
    await expect(shareButton).toBeVisible({ timeout: TIMEOUTS.QUICK });
    await shareButton.click();
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.QUICK });
  }).toPass({ timeout: TIMEOUTS.CONVERSATION_LOAD });
  return modal;
}

/**
 * Hover the first assistant message, click Share, wait for the share-message
 * modal, click Create, capture the rendered share URL, then press Escape to
 * dismiss the modal. Returns the share URL (always starts with `/share/m/`
 * and includes a `#` fragment with the share secret).
 */
export async function createMessageShareUrl(chatPage: ChatPage): Promise<string> {
  const { page } = chatPage;
  const aiMessage = chatPage.messageList.locator(`[${TEST_SIGNALS.role}="assistant"]`).first();
  await openShareModalForMessage(page, aiMessage);

  await page.getByTestId(TEST_IDS.shareMessageCreateButton).click();

  const urlEl = page.getByTestId(TEST_IDS.shareMessageUrl);
  await expect(urlEl).toBeVisible();
  const shareUrl = (await urlEl.textContent()) ?? '';
  expect(shareUrl).toContain('/share/m/');
  expect(shareUrl).toContain('#');

  await page.keyboard.press('Escape');
  return shareUrl;
}
