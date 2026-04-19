import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

/**
 * Image generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default) which returns a canned 1x1 PNG via
 * `google/imagen-4`. Asserts the UI round-trip: switch to image modality,
 * pick an aspect ratio, send prompt, see an `<img>` element render.
 */
test.describe('Image Generation', () => {
  test('switches to image modality, generates, and renders inline', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    // Step 1: switch modality
    const imageIcon = authenticatedPage.getByRole('button', { name: /switch to image/i });
    await expect(imageIcon).toBeVisible();
    await imageIcon.click();

    // Step 2: aspect ratio picker renders
    await expect(authenticatedPage.getByRole('button', { name: '1:1' })).toBeVisible();
    await expect(authenticatedPage.getByRole('button', { name: '16:9' })).toBeVisible();

    // Step 3: send prompt
    const prompt = `A photo of a sunset over mountains ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    // Step 4: image content item renders as <img> with download link
    const imageElement = chatPage.messageList.locator('img').first();
    await expect(imageElement).toBeVisible({ timeout: 30_000 });
    const downloadLink = chatPage.messageList
      .getByRole('link', { name: /download media/i })
      .first();
    await expect(downloadLink).toBeVisible();
  });

  test('changing aspect ratio updates the active button state', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await authenticatedPage.getByRole('button', { name: /switch to image/i }).click();

    // 1:1 is default
    const oneToOne = authenticatedPage.getByRole('button', { name: '1:1' });
    const sixteenNine = authenticatedPage.getByRole('button', { name: '16:9' });
    await expect(oneToOne).toHaveAttribute('aria-pressed', 'true');
    await expect(sixteenNine).toHaveAttribute('aria-pressed', 'false');

    await sixteenNine.click();
    await expect(sixteenNine).toHaveAttribute('aria-pressed', 'true');
    await expect(oneToOne).toHaveAttribute('aria-pressed', 'false');
  });
});
