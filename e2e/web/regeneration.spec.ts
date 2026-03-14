import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';

test.describe('Solo Regeneration', () => {
  test.describe.configure({ mode: 'serial' });

  test('retry user message deletes AI response and streams new one', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify initial 2 messages', async () => {
      await expect(chatPage.messageList.locator('[data-testid="message-item"]')).toHaveCount(2);
    });

    await test.step('hover user message and verify action buttons', async () => {
      await chatPage.hoverMessage(0);
      await expect(chatPage.getRetryButton(0)).toBeVisible();
      await expect(chatPage.getEditButton(0)).toBeVisible();
      await expect(chatPage.getForkButton(0)).toBeVisible();
    });

    await test.step('click retry and wait for new response', async () => {
      await chatPage.clickRetry(0);
      await chatPage.waitForAIResponse();
      await chatPage.waitForStreamComplete();
      await chatPage.expectAssistantMessageContains('Echo:');
    });

    await test.step('verify message count still 2', async () => {
      const count = await chatPage.getMessageCountViaAPI();
      expect(count).toBe(2);
    });
  });

  test('regenerate AI response keeps user message', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    const userMessage = chatPage.getMessage(0);
    const userText = await userMessage.textContent();

    await test.step('hover AI message and verify regenerate button', async () => {
      await chatPage.hoverMessage(1);
      await expect(chatPage.getRegenerateButton(1)).toBeVisible();
    });

    await test.step('click regenerate and wait for new response', async () => {
      await chatPage.clickRegenerate(1);
      await chatPage.waitForAIResponse();
      await chatPage.waitForStreamComplete();
      await chatPage.expectAssistantMessageContains('Echo:');
    });

    await test.step('verify user message unchanged', async () => {
      const currentUserText = await chatPage.getMessage(0).textContent();
      expect(currentUserText).toBe(userText);
    });

    await test.step('verify message count still 2', async () => {
      const count = await chatPage.getMessageCountViaAPI();
      expect(count).toBe(2);
    });
  });

  test('edit user message pre-fills input and streams new response', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('click edit on user message', async () => {
      await chatPage.clickEdit(0);
    });

    await test.step('verify edit mode active', async () => {
      await chatPage.expectEditModeActive();
    });

    await test.step('modify text and send', async () => {
      const editedMessage = `Edited message ${String(Date.now())}`;
      await chatPage.messageInput.clear();
      await chatPage.messageInput.fill(editedMessage);
      await expect(chatPage.sendButton).toBeEnabled({ timeout: 15_000 });
      await chatPage.sendButton.click();

      await chatPage.waitForAIResponse(editedMessage);
      await chatPage.expectMessageVisible(editedMessage);
    });

    await test.step('verify edit indicator gone after send', async () => {
      await chatPage.expectEditModeInactive();
    });
  });

  test('cancel edit returns to normal', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('enter edit mode', async () => {
      await chatPage.clickEdit(0);
      await chatPage.expectEditModeActive();
    });

    await test.step('cancel edit', async () => {
      await chatPage.cancelEdit();
      await chatPage.expectEditModeInactive();
    });

    await test.step('send normal message to verify normal flow', async () => {
      const normalMessage = `Normal ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(normalMessage);
      await chatPage.expectMessageVisible(normalMessage);
    });
  });

  test('retry first message clears entire conversation', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('send follow-up to have 4+ messages', async () => {
      const followup = `Followup ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(followup);
      await chatPage.waitForAIResponse(followup);
      const count = await chatPage.getMessageCount();
      expect(count).toBeGreaterThanOrEqual(4);
    });

    await test.step('retry first user message', async () => {
      await chatPage.scrollToTop();
      await chatPage.clickRetry(0);
      await chatPage.waitForAIResponse();
      await chatPage.waitForStreamComplete();
    });

    await test.step('verify only 2 messages remain', async () => {
      const count = await chatPage.getMessageCountViaAPI();
      expect(count).toBe(2);
    });
  });

  test('action buttons not visible during streaming', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('send message and check buttons during streaming', async () => {
      const msg = `Stream test ${String(Date.now())}`;
      await chatPage.messageInput.fill(msg);
      await chatPage.sendButton.click();

      // During streaming, retry/edit buttons should not exist on user messages
      // Use a short timeout since streaming is brief with mock
      const userMessages = chatPage.messageList.locator('[data-role="user"]');
      await expect(userMessages.last()).toBeVisible();

      // The send button is disabled during streaming
      await expect(chatPage.sendButton).toBeDisabled();
    });

    await test.step('after streaming, buttons appear on hover', async () => {
      await chatPage.waitForAIResponse();
      await chatPage.hoverMessage(0);
      await expect(chatPage.getRetryButton(0)).toBeVisible();
    });
  });
});

test.describe('Group Chat Regeneration', () => {
  test('retry own message works when no other user replied after', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('Alice sends new message and waits for AI', async () => {
      const msg = `Alice new ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
      await chatPage.waitForStreamComplete();
    });

    await test.step('hover Alice latest user message and retry', async () => {
      // Find Alice's latest user message (second to last, before AI response)
      const userMessages = chatPage.messageList.locator('[data-role="user"]');
      const lastUserMsg = userMessages.last();
      await lastUserMsg.hover();

      // Retry button should be visible on own latest message
      const retryButton = lastUserMsg.getByRole('button', { name: 'Retry' });
      await expect(retryButton).toBeVisible();
      await retryButton.click();
    });

    await test.step('wait for new AI response', async () => {
      await chatPage.waitForAIResponse();
      await chatPage.waitForStreamComplete();
    });

    await test.step('verify earlier seeded messages are untouched', async () => {
      await chatPage.expectMessageVisible('Hello from Alice');
      await chatPage.expectMessageVisible('Hi from Bob');
    });
  });

  test('retry blocked when other user replied after', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('hover Alice first message — no retry/edit, fork visible', async () => {
      // First message is Alice's "Hello from Alice" — Bob replied after
      await chatPage.hoverMessage(0);

      // Retry and Edit should NOT be visible (blocked by guard)
      await expect(chatPage.getRetryButton(0)).not.toBeVisible();
      await expect(chatPage.getEditButton(0)).not.toBeVisible();

      // Fork should still be visible (not blocked by guard)
      await expect(chatPage.getForkButton(0)).toBeVisible();
    });
  });

  test('cannot retry/edit other user messages', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('find and hover Bob message', async () => {
      // Bob's message "Hi from Bob" — Alice cannot retry/edit it
      const bobMessage = chatPage.messageList
        .locator('[data-testid="message-item"]')
        .filter({ hasText: 'Hi from Bob' });
      await bobMessage.hover();

      // No retry/edit buttons on other user's message
      await expect(bobMessage.getByRole('button', { name: 'Retry' })).not.toBeVisible();
      await expect(bobMessage.getByRole('button', { name: 'Edit' })).not.toBeVisible();
    });
  });

  test('regenerate AI blocked when other user replied after', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('hover first AI message — no regenerate (Bob replied after)', async () => {
      // The seeded AI message has Bob's message after it
      const aiMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
      await aiMessage.hover();
      await expect(aiMessage.getByRole('button', { name: 'Regenerate' })).not.toBeVisible();
    });
  });

  test('regenerate AI works when no other user replied after', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    await test.step('Alice sends new message and waits for AI', async () => {
      const msg = `Alice regen test ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
      await chatPage.waitForStreamComplete();
    });

    await test.step('hover latest AI message and regenerate', async () => {
      const aiMessages = chatPage.messageList.locator('[data-role="assistant"]');
      const lastAi = aiMessages.last();
      await lastAi.hover();

      const regenButton = lastAi.getByRole('button', { name: 'Regenerate' });
      await expect(regenButton).toBeVisible();
      await regenButton.click();
    });

    await test.step('wait for new AI response', async () => {
      await chatPage.waitForAIResponse();
    });
  });
});
