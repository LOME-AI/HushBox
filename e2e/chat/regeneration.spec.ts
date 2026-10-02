import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages/index.js';
import { nextTurnRequest } from '../helpers/turn-request.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { TurnSourceList } from '@hushbox/shared';
import type { Request } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The user-message id the server minted for a captured turn and named on its
 * run-start response. The server persists the turn's user message under
 * exactly this id, so it is what the reconciled row carries, and what a Retry
 * on that row sends as `targetMessageId`. An absent field is a failure rather
 * than a value: a fresh run's response always names one.
 */
async function returnedUserMessageId(request: Request): Promise<string> {
  const response = await request.response();
  if (response === null) throw new Error('the turn request got no response');
  const body = (await response.json()) as { userMessageId?: unknown };
  if (typeof body.userMessageId !== 'string') {
    throw new TypeError('the run-start response named no user message id');
  }
  return body.userMessageId;
}

test.describe('Solo Regeneration', SPEC_MATRIX, () => {
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
      // Regenerate re-streams a full turn. Use the wider STREAM_CLEAR budget
      // (not STREAM) so the cycle still completes when every browser project's
      // workers run at once and saturate the host (see resource-scan) — the
      // same rationale as the conversation-clear retry below.
      await chatPage.withStreamCycle(() => chatPage.clickRegenerate(1), TIMEOUTS.STREAM_CLEAR);
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
    testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    const baseline = await chatPage.captureStreamBaseline();

    await test.step('send message and check buttons during streaming', async () => {
      // The mock stream parks after its first chunk, so the run is still
      // observably in flight when the assertions below evaluate.
      await chatPage.holdPrimaryStreamForNextSends();
      const msg = `Stream test ${String(Date.now())}`;
      await chatPage.messageInput.fill(msg);
      await chatPage.sendButton.click();
      await chatPage.waitForStreamingActive();

      const userMessages = chatPage.messagesByRole('user');
      await expect(userMessages.last()).toBeVisible();

      // Only the streaming message's own toolbar is withheld. The user message
      // keeps its retry control for the whole run — refused with a stated
      // reason rather than hidden — so asserting that control away is wrong
      // about the app.
      const streamingAssistant = chatPage.messagesByRole('assistant').last();
      await expect(streamingAssistant).toBeVisible();
      await expect(streamingAssistant.getByTestId(TEST_IDS.messageActions)).not.toBeVisible();

      await expect(chatPage.sendButton).toBeDisabled();
    });

    await test.step('after streaming, buttons appear on hover', async () => {
      await chatPage.stopHoldingStreams();
      await chatPage.releaseHeldStream(testConversation.id);
      await chatPage.waitForStreamCycle(baseline);
      await chatPage.prepareMessage(0);
      await expect(chatPage.getRetryButton(0)).toBeVisible();
    });
  });

  // Multi-model retry must regenerate the FAILED model, not the
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
      await chatPage.withStreamCycle(
        () => chatPage.sendNewChatMessage(`Multi-model retry ${String(Date.now())}`),
        TIMEOUTS.MEDIA_DECODE
      );
      await chatPage.waitForConversation();

      const errorTile = authenticatedPage.getByTestId(TEST_IDS.modelErrorMessage);
      await expect(errorTile).toBeVisible({ timeout: TIMEOUTS.ASSERT });

      // Clear the failing-models header so the retry attempt can succeed —
      // we want to confirm the regenerate hits the FAILED model id.
      await authenticatedPage.setExtraHTTPHeaders({});

      // Capture the regenerate request body to assert the turn's answer source.
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
      const body = JSON.parse(regenerateRequest.postData() ?? '{}') as {
        turnSources?: TurnSourceList;
      };
      expect(body.turnSources).toEqual([{ kind: 'model', id: failModelId }]);
    } finally {
      await authenticatedPage.setExtraHTTPHeaders({});
    }
  });
});

test.describe('Group Chat Regeneration', SPEC_MATRIX, () => {
  test('retry own message works when no other user replied after', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();

    const msg = `Alice new ${String(Date.now())}`;
    let sentUserMessageId = '';

    await test.step('Alice sends new message and waits for AI', async () => {
      const requested = nextTurnRequest(authenticatedPage);
      await chatPage.withStreamCycle(() => chatPage.sendFollowUpMessage(msg));
      sentUserMessageId = await returnedUserMessageId(await requested);
      await chatPage.waitForAIResponse(msg);
    });

    await test.step('hover Alice latest user message and retry', async () => {
      // Alice's latest user message (last in the list, before its AI reply).
      const lastUserMsg = chatPage.messagesByRole('user').last();

      // The retry sends the id THIS row carries, so the row has to be carrying
      // the server's. A just-sent message renders optimistically under a
      // client-only id, and the merge appends surviving optimistic rows AFTER
      // the API rows — so a window holds both with the client-only one last.
      // `data-streams-completed` advances at persistence (SSE `done`), which
      // lands before the reconcile refetch, so a stream-cycle gate alone can
      // leave that row last: the retry then sends a targetMessageId the
      // server's tip-walk can't find, walks past another member's seeded
      // message to the root, and 403s (REGENERATION_BLOCKED_BY_OTHER_USER).
      // Pinning the wire id on the LAST row is the reconcile having landed and
      // the optimistic row being gone, in one fact.
      await expect(lastUserMsg).toHaveAttribute(TEST_SIGNALS.messageId, sentUserMessageId, {
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });

      await lastUserMsg.hover();

      const retryButton = lastUserMsg.getByRole('button', { name: 'Retry' });
      await expect(retryButton).toBeVisible();
      // A blocked retry produces no new stream cycle, so this gate fails loudly
      // — unlike a content wait for any `Echo:` row, which matched the prior
      // turn's echo and masked a 403.
      await chatPage.withStreamCycle(() => retryButton.click());
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

    const msg = `Alice regen test ${String(Date.now())}`;

    await test.step('Alice sends new message and waits for AI', async () => {
      await chatPage.sendFollowUpMessage(msg);
      await chatPage.waitForAIResponse(msg);
    });

    const streamBaseline = await chatPage.captureStreamBaseline();

    await test.step('hover latest AI message and regenerate', async () => {
      await chatPage.waitForMessagesReady();
      const aiMessages = chatPage.messagesByRole('assistant');
      const lastAi = aiMessages.last();
      await lastAi.hover();

      const regenButton = lastAi.getByRole('button', { name: 'Regenerate' });
      await expect(regenButton).toBeVisible();
      await regenButton.click();
    });

    await test.step('wait for new AI response', async () => {
      await chatPage.waitForStreamCycle(streamBaseline);
      await chatPage.waitForAIResponse(msg);
    });
  });
});
