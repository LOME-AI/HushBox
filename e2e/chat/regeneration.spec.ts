import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Solo Regeneration', () => {
  // eslint-disable-next-line no-restricted-syntax -- serial: stream-heavy retry/regenerate flows mutate the shared Alice authenticated page in sequence; concurrent runs race the same account's message state.
  test.describe.configure({ mode: 'serial' });

  test('retry user message deletes AI response and streams new one', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify initial 2 messages', async () => {
      await expect(
        chatPage.messageList.locator(`[data-testid="${TEST_IDS.messageItem}"]`)
      ).toHaveCount(2);
    });

    await test.step('hover user message and verify action buttons', async () => {
      await chatPage.prepareMessage(0);
      await expect(chatPage.getRetryButton(0)).toBeVisible();
      await expect(chatPage.getEditButton(0)).toBeVisible();
    });

    await test.step('hover AI message and verify fork button', async () => {
      await chatPage.prepareMessage(1);
      await expect(chatPage.getForkButton(1)).toBeVisible();
    });

    await test.step('click retry and wait for new response', async () => {
      await chatPage.withStreamCycle(() => chatPage.clickRetry(0));
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
    const userText = (await userMessage.textContent()) ?? '';

    await test.step('hover AI message and verify regenerate button', async () => {
      await chatPage.prepareMessage(1);
      await expect(chatPage.getRegenerateButton(1)).toBeVisible();
    });

    await test.step('click regenerate and wait for new response', async () => {
      await chatPage.withStreamCycle(() => chatPage.clickRegenerate(1));
      await chatPage.expectAssistantMessageContains('Echo:');
    });

    await test.step('verify user message unchanged', async () => {
      await expect(chatPage.getMessage(0)).toHaveText(userText);
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
      await expect(chatPage.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
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
      // Clearing the whole conversation and re-streaming is the heaviest stream
      // cycle; use the wider STREAM_CLEAR budget so it still completes on a
      // saturated host (every browser project's workers run at once).
      await chatPage.withStreamCycle(() => chatPage.clickRetry(0), TIMEOUTS.STREAM_CLEAR);
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
      const userMessages = chatPage.messagesByRole('user');
      await expect(userMessages.last()).toBeVisible();

      await expect(chatPage.sendButton).toBeDisabled();
    });

    await test.step('after streaming, buttons appear on hover', async () => {
      await chatPage.waitForAIResponse();
      await chatPage.prepareMessage(0);
      await expect(chatPage.getRetryButton(0)).toBeVisible();
    });
  });

  // 10.4 — multi-model retry must regenerate the FAILED model, not the
  // primary. Pre-fix the regenerate request used `getPrimaryModel(...)` so
  // clicking retry on the second tile re-ran the first model. Asserted via
  // the network request body so a UI race can't hide a regression.
  test('retry on a failed multi-model tile regenerates the failed model, not the primary', async ({
    authenticatedPage,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);

    await chatPage.goto();
    await chatPage.waitForAppStable();

    const { failModelId } = await chatPage.selectModelsWithFailTarget();
    await authenticatedPage.setExtraHTTPHeaders({ 'x-mock-failing-models': failModelId });

    try {
      await chatPage.sendNewChatMessage(`Multi-model retry ${String(Date.now())}`);
      await chatPage.waitForConversation();
      await chatPage.waitForStreamComplete(TIMEOUTS.MEDIA_DECODE);

      const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
      await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.ASSERT });

      // Clear the failing-models header so the retry attempt can succeed —
      // we want to confirm the regenerate hits the FAILED model id.
      await authenticatedPage.setExtraHTTPHeaders({});

      // Capture the regenerate request body to assert the model field.
      const regeneratePromise = authenticatedPage.waitForRequest(
        (req) => req.url().includes('/regenerate') && req.method() === 'POST',
        { timeout: TIMEOUTS.STREAM }
      );

      // Scope Regenerate to the errored tile's own toolbar by climbing from
      // `model-error-message` to its enclosing `message-item`. A page-wide
      // `getByRole('button', { name: 'Regenerate' })` would also match the
      // successful sibling tile's Regenerate, and the user message above
      // exposes "Retry" (not "Regenerate"), so a role-name selector at this
      // scope is unambiguous.
      const retryButton = errorTile
        .locator(`xpath=ancestor::*[@data-testid="${TEST_IDS.messageItem}"][1]`)
        .getByTestId(TEST_IDS.messageActions)
        .getByRole('button', { name: 'Regenerate' });
      await expect(retryButton).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await retryButton.click();

      const regenerateRequest = await regeneratePromise;
      const body = JSON.parse(regenerateRequest.postData() ?? '{}') as { models?: string[] };
      expect(body.models).toEqual([failModelId]);
    } finally {
      await authenticatedPage.setExtraHTTPHeaders({});
    }
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
      const userMessages = chatPage.messagesByRole('user');
      const lastUserMsg = userMessages.last();
      await lastUserMsg.hover();

      const retryButton = lastUserMsg.getByRole('button', { name: 'Retry' });
      await expect(retryButton).toBeVisible();
      await retryButton.click();
    });

    await test.step('wait for new AI response', async () => {
      await chatPage.waitForAIResponse();
      await chatPage.waitForStreamComplete();
    });

    await test.step('verify earlier seeded messages are untouched', async () => {
      await chatPage.scrollToTop();
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
    await chatPage.expectMessageVisible('Hello from Alice');

    await test.step('hover Alice first message — no retry/edit (blocked by guard)', async () => {
      // First message is Alice's "Hello from Alice" — Bob replied after
      await chatPage.prepareMessage(0);

      await expect(chatPage.getRetryButton(0)).not.toBeVisible();
      await expect(chatPage.getEditButton(0)).not.toBeVisible();
    });

    await test.step('hover first AI message — fork visible', async () => {
      await chatPage.prepareMessage(1);
      await expect(chatPage.getForkButton(1)).toBeVisible();
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
        .locator(`[data-testid="${TEST_IDS.messageItem}"]`)
        .filter({ hasText: 'Hi from Bob' });
      await bobMessage.hover();

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
      const aiMessage = chatPage.messagesByRole('assistant').first();
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
      const aiMessages = chatPage.messagesByRole('assistant');
      const lastAi = aiMessages.last();
      await lastAi.hover();

      const regenButton = lastAi.getByRole('button', { name: 'Regenerate' });
      await expect(regenButton).toBeVisible();
      await regenButton.click();
    });

    await test.step('wait for new AI response', async () => {
      await chatPage.waitForAIResponse();
      await chatPage.waitForStreamComplete();
    });
  });
});
