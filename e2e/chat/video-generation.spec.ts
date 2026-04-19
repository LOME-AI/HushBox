import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

/**
 * Video generation flow end-to-end.
 *
 * Uses the mock AIClient (dev/E2E default) which returns a canned 44-byte MP4
 * via `google/veo-3.1`. The test asserts the UI round-trip: switch modality,
 * configure video, send prompt, see a `<video>` element render with a download
 * button. Doesn't assert playback — the canned bytes aren't enough frames.
 */
test.describe('Video Generation', () => {
  test('switches to video modality, generates, and renders inline', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    // Step 1: switch to video modality via the icon button
    const videoIcon = authenticatedPage.getByRole('button', { name: /switch to video/i });
    await expect(videoIcon).toBeVisible();
    await videoIcon.click();

    // Step 2: the modality config panel renders with aspect ratio, resolution, duration
    await expect(authenticatedPage.getByRole('button', { name: '16:9' })).toBeVisible();
    await expect(authenticatedPage.getByRole('button', { name: '9:16' })).toBeVisible();
    // Resolution button labels include inline per-second price from the primary model
    await expect(authenticatedPage.getByRole('button', { name: /720p/i })).toBeVisible();
    const durationSlider = authenticatedPage.getByRole('slider', {
      name: /video duration in seconds/i,
    });
    await expect(durationSlider).toBeVisible();

    // Step 3: send the prompt
    const prompt = `Generate a clip of a cat surfing ${String(Date.now())}`;
    await chatPage.sendNewChatMessage(prompt);
    await chatPage.waitForConversation();
    await chatPage.expectMessageVisible(prompt);

    // Step 4: assistant message contains a <video> element once generation completes
    const videoElement = chatPage.messageList.locator('video').first();
    await expect(videoElement).toBeVisible({ timeout: 30_000 });
    // Download affordance should be present for any media content item
    const downloadLink = chatPage.messageList
      .getByRole('link', { name: /download media/i })
      .first();
    await expect(downloadLink).toBeVisible();
  });

  test('resolution button labels include per-second price', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.expectNewChatPageVisible();

    await authenticatedPage.getByRole('button', { name: /switch to video/i }).click();

    // Mock Veo 3.1 prices 720p/1080p — labels should render as "720p $0.10/s" etc.
    const resButton = authenticatedPage.getByRole('button', { name: /720p\s+\$\d+\.\d+\/s/i });
    await expect(resButton).toBeVisible();
  });
});
