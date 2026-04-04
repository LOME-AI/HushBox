import type { Page } from '@playwright/test';
import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages';

async function setupRealtimePair(
  alicePage: Page,
  bobPage: Page,
  conversationId: string
): Promise<{ aliceChatPage: ChatPage; bobChatPage: ChatPage }> {
  const aliceChatPage = new ChatPage(alicePage);
  const bobChatPage = new ChatPage(bobPage);

  await aliceChatPage.gotoConversation(conversationId);
  await bobChatPage.gotoConversation(conversationId);

  await aliceChatPage.waitForConversationLoaded();
  await bobChatPage.waitForConversationLoaded();

  await aliceChatPage.waitForWebSocketConnected();
  await bobChatPage.waitForWebSocketConnected();

  // Allow server-side (Durable Object) to finish registering WebSocket connections
  await bobChatPage.page.waitForTimeout(500);

  return { aliceChatPage, bobChatPage };
}

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

    // Alice sends a timestamped message
    const timestamp = String(Date.now());
    const testMessage = `Realtime test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    // Alice sees her own message
    await aliceChatPage.expectMessageVisible(testMessage);

    // Bob sees Alice's message appear WITHOUT refresh (via WebSocket)
    await unsettledExpect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: 15_000,
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

    // Alice sends a message with AI on (default)
    const timestamp = String(Date.now());
    const testMessage = `AI test ${timestamp}`;
    await aliceChatPage.sendFollowUpMessage(testMessage);

    // Bob sees Alice's user message appear (via message:new with content — phantom)
    await unsettledExpect(bobChatPage.messageList.getByText(testMessage).first()).toBeVisible({
      timeout: 15_000,
    });

    // Bob sees an assistant message element appear (via message:stream — phantom AI)
    await unsettledExpect(
      bobChatPage.messageList.locator('[data-role="assistant"]').last()
    ).toBeVisible({
      timeout: 15_000,
    });

    // Alice waits for AI Echo response to complete
    await aliceChatPage.waitForAIResponse(testMessage);

    // Bob sees complete AI "Echo:" response (phantoms replaced by real messages via message:complete)
    await unsettledExpect(bobChatPage.messageList.getByText('Echo:').last()).toBeVisible({
      timeout: 15_000,
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

    // Alice starts typing (fill but don't submit)
    await aliceChatPage.messageInput.fill('typing test');

    // Bob sees typing indicator appear
    await unsettledExpect(bobChatPage.getTypingIndicator()).toBeVisible({ timeout: 10_000 });

    // Alice toggles AI off and submits (faster, no streaming)
    const aiToggle = aliceChatPage.getAiToggleButton();
    await aiToggle.click();
    await aliceChatPage.messageInput.press('Enter');

    // Bob's typing indicator disappears
    await unsettledExpect(bobChatPage.getTypingIndicator()).not.toBeVisible({ timeout: 10_000 });
  });
});
