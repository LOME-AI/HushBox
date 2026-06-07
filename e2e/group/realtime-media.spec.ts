import { test, expect } from '../fixtures.js';
import { setupRealtimePair } from '../helpers/realtime.js';
import { TIMEOUTS } from '../config/timeouts.js';

/**
 * Lane 9 #4: real-time fan-out of generated media. After Alice generates an
 * image inside a group conversation, Bob's view (without refresh) must show
 * the new assistant message AND a decoded inline `<img>` — proving that the
 * Durable Object delivered both the message envelope and the media URL/key
 * over the WebSocket and Bob's client successfully decrypted the bytes.
 */
test.describe('Real-time media broadcast', () => {
  test('Bob sees Alice-generated image render without refresh', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    test.slow();

    const { aliceChatPage, bobChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    // Capture Bob's pre-generation assistant count so we can assert growth
    // rather than absolute numbers (the seeded group conversation already has
    // a couple of assistant messages from the fixture).
    const beforeAssistantCount = Number(
      (await bobChatPage.messageList.getAttribute('data-assistant-count')) ?? '0'
    );

    const aliceImageIcon = authenticatedPage.getByRole('button', { name: /switch to image/i });
    await expect(aliceImageIcon).toBeVisible();
    await aliceImageIcon.click();
    await expect(authenticatedPage.getByRole('button', { name: '1:1' })).toBeVisible();

    const prompt = `Realtime image ${String(Date.now())}`;
    await aliceChatPage.sendFollowUpMessage(prompt);
    await aliceChatPage.expectImageVisible(TIMEOUTS.MEDIA_DECODE);
    await aliceChatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

    // Bob's React state knows about a new assistant message via WebSocket fan-out.
    await expect(bobChatPage.messageList).toHaveAttribute(
      'data-assistant-count',
      String(beforeAssistantCount + 1),
      { timeout: TIMEOUTS.MEDIA_DECODE }
    );

    // iPhone-15 Virtuoso virtualizes the user-prompt row off-screen.
    const bobLastRowIndex = await bobChatPage.getLastRowIndex();
    await bobChatPage.scrollMessageIntoView(bobLastRowIndex - 1);
    await expect(bobChatPage.messageList.getByText(prompt).first()).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });

    // Bob's last assistant message renders an `<img>` whose pixel data decoded
    // (naturalWidth > 0). This proves the realtime broadcast carried the
    // wrapped content key + storage reference and Bob's client minted a fresh
    // download URL and decrypted the bytes.
    const bobLastImage = bobChatPage
      .imagesIn(bobChatPage.messagesByRole('assistant').last())
      .first();
    await expect(bobLastImage).toBeVisible({ timeout: TIMEOUTS.MEDIA_DECODE });
    await expect
      .poll(async () => bobLastImage.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: TIMEOUTS.MEDIA_DECODE,
      })
      .toBeGreaterThan(0);
  });
});
