import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

// WebSocket events arrive after the receiving page has settled — opt out of
// settled quick-fail for cross-page assertions where Bob waits for Alice's events.
const wsExpect = expect.configure({ settledAware: false });

test.describe('Real-time WebSocket events', () => {
  test('user-only message appears for other member in real time', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // Both Alice and Bob navigate to the same conversation
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await aliceChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.gotoConversation(groupConversation.id);

    await aliceChatPage.waitForConversationLoaded();
    await bobChatPage.waitForConversationLoaded();

    // Alice toggles AI off (avoids waiting for streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await expect(aiToggle).toHaveAccessibleName(/AI response off/);

    // Alice sends a timestamped message
    const timestamp = String(Date.now());
    const testMessage = `Realtime test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    // Alice sees her own message
    await aliceChatPage.expectMessageVisible(testMessage);

    // Bob sees Alice's message appear WITHOUT refresh (via WebSocket)
    await wsExpect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('AI streaming: Bob sees Alice user message immediately and AI response progressively', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    test.slow();
    // Both navigate to the group conversation
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await aliceChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.gotoConversation(groupConversation.id);

    await aliceChatPage.waitForConversationLoaded();
    await bobChatPage.waitForConversationLoaded();

    // Alice sends a message with AI on (default)
    const timestamp = String(Date.now());
    const testMessage = `AI test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    // Bob sees Alice's user message appear (via message:new with content — phantom)
    await wsExpect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: 15_000,
    });

    // Bob sees an assistant message element appear (via message:stream — phantom AI)
    await wsExpect(bobChatPage.messageList.locator('[data-role="assistant"]').last()).toBeVisible({
      timeout: 15_000,
    });

    // Alice waits for AI Echo response to complete
    await aliceChatPage.waitForAIResponse(testMessage);

    // Bob sees complete AI "Echo:" response (phantoms replaced by real messages via message:complete)
    await wsExpect(bobChatPage.messageList.getByText('Echo:').last()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('typing indicator shows for other member', async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // Both navigate to the group conversation
    const aliceChatPage = new ChatPage(authenticatedPage);
    const bobChatPage = new ChatPage(testBobPage);

    await aliceChatPage.gotoConversation(groupConversation.id);
    await bobChatPage.gotoConversation(groupConversation.id);

    await aliceChatPage.waitForConversationLoaded();
    await bobChatPage.waitForConversationLoaded();

    // Wait for WebSocket connections (both must be connected for typing events to flow)
    await aliceChatPage.waitForWebSocketConnected();
    await bobChatPage.waitForWebSocketConnected();

    // Alice starts typing (fill but don't submit)
    await aliceChatPage.messageInput.fill('typing test');

    // Bob sees typing indicator appear
    await wsExpect(bobChatPage.getTypingIndicator()).toBeVisible({ timeout: 10_000 });

    // Alice toggles AI off and submits (faster, no streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await aliceChatPage.messageInput.press('Enter');

    // Bob's typing indicator disappears
    await wsExpect(bobChatPage.getTypingIndicator()).not.toBeVisible({ timeout: 10_000 });
  });
});
