import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { expect } from './expect.js';
import type { ChatPage } from '../pages/index.js';

/**
 * Hover the first assistant message, click Share, wait for the share-message
 * modal, click Create, capture the rendered share URL, then press Escape to
 * dismiss the modal. Returns the share URL (always starts with `/share/m/`
 * and includes a `#` fragment with the share secret).
 */
export async function createMessageShareUrl(chatPage: ChatPage): Promise<string> {
  const { page } = chatPage;
  const aiMessage = chatPage.messageList.locator(`[${TEST_SIGNALS.role}="assistant"]`).first();
  await aiMessage.hover();

  const shareButton = aiMessage.getByRole('button', { name: 'Share' });
  await expect(shareButton).toBeVisible();
  await shareButton.click();

  const modal = page.getByTestId(TEST_IDS.shareMessageModal);
  await expect(modal).toBeVisible();
  await page.getByTestId(TEST_IDS.shareMessageCreateButton).click();

  const urlEl = page.getByTestId(TEST_IDS.shareMessageUrl);
  await expect(urlEl).toBeVisible();
  const shareUrl = (await urlEl.textContent()) ?? '';
  expect(shareUrl).toContain('/share/m/');
  expect(shareUrl).toContain('#');

  await page.keyboard.press('Escape');
  return shareUrl;
}
