import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';
import { setupRealtimePair } from '../helpers/realtime.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Real-time WebSocket events', () => {
  test('user-only message appears for other member in real time', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    const { aliceChatPage, bobChatPage } = await setupRealtimePair(
      authenticatedPage,
      testBobPage,
      groupConversation.id
    );

    // Alice toggles AI off (avoids waiting for streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await expect(aiToggle).toHaveAccessibleName(/AI response off/);

    const timestamp = String(Date.now());
    const testMessage = `Realtime test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    await aliceChatPage.expectMessageVisible(testMessage);

    // Bob sees Alice's message appear WITHOUT refresh (via WebSocket)
    await expect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
  });

  test('AI streaming: Bob sees Alice user message immediately and AI response progressively', async ({
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

    const timestamp = String(Date.now());
    const testMessage = `AI test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    // Bob sees Alice's user message appear (via message:new with content — phantom)
    await expect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });

    // Bob sees an assistant message element appear (via message:stream — phantom AI)
    await expect(bobChatPage.messageList.locator('[data-role="assistant"]').last()).toBeVisible({
      timeout: TIMEOUTS.STREAM,
    });

    await aliceChatPage.waitForAIResponse(testMessage);

    // Bob sees complete AI "Echo:" response (phantoms replaced by real messages via message:complete)
    await expect(bobChatPage.messageList.getByText('Echo:').last()).toBeVisible({
      timeout: TIMEOUTS.STREAM,
    });
  });

  test('typing indicator shows for other member', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // Both navigate to the group conversation (no DO wait needed for typing)
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await aliceChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.gotoConversation(groupConversation.id);

    await aliceChatPage.waitForConversationLoaded();
    await bobChatPage.waitForConversationLoaded();

    // Wait for WebSocket connections (both must be connected for typing events to flow)
    await aliceChatPage.waitForWebSocketConnected();
    await bobChatPage.waitForWebSocketConnected();

    await aliceChatPage.messageInput.fill('typing test');

    await expect(bobChatPage.getTypingIndicator()).toBeVisible({ timeout: TIMEOUTS.WS_HANDSHAKE });

    // Alice toggles AI off and submits (faster, no streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await aliceChatPage.messageInput.press('Enter');

    await expect(bobChatPage.getTypingIndicator()).not.toBeVisible({
      timeout: TIMEOUTS.WS_HANDSHAKE,
    });
  });
});
