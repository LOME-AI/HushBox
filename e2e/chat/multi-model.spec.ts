import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';
import { requireEnv } from '../helpers/env.js';

const apiUrl = requireEnv('VITE_API_URL');

test.describe('Multi-Model Chat', () => {
  test.describe('Model Selection', () => {
    test('selects multiple models via toggle in modal', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('open modal and select 3 models', async () => {
        await chatPage.selectModels(3);
      });

      await test.step('verify header shows "Multiple Models"', async () => {
        const button = authenticatedPage.getByTestId('model-selector-button');
        await expect(button).toContainText('Multiple Models');
      });

      await test.step('verify comparison bar shows 3 pills', async () => {
        await chatPage.expectComparisonBarVisible();
        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(3);
      });
    });

    test('removes model from comparison bar', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models', async () => {
        await chatPage.selectModels(3);
        await chatPage.expectComparisonBarVisible();
      });

      await test.step('remove one model via X — bar shows 2', async () => {
        const bar = authenticatedPage.getByTestId('selected-models-bar');
        const firstRemoveButton = bar.locator('button[aria-label^="Remove "]').first();
        await firstRemoveButton.click();

        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(2);
      });

      await test.step('remove another — bar disappears, single model in header', async () => {
        const bar = authenticatedPage.getByTestId('selected-models-bar');
        const removeButton = bar.locator('button[aria-label^="Remove "]').first();
        await removeButton.click();

        await chatPage.expectComparisonBarHidden();
        const button = authenticatedPage.getByTestId('model-selector-button');
        await expect(button).not.toContainText('Multiple Models');
      });
    });

    test('enforces max model limit', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 5 models (max)', async () => {
        await chatPage.selectModels(5);
        await chatPage.expectComparisonBarVisible();
        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(5);
      });

      await test.step('verify unselected models are dimmed in modal', async () => {
        await chatPage.openModelSelector();
        const modal = authenticatedPage.getByTestId('model-selector-modal');

        // Find an unselected model (not disabled by premium lock)
        const unselectedModels = modal.locator(
          '[data-testid^="model-item-"][data-selected="false"]:not(:has([data-testid="lock-icon"]))'
        );
        const unselectedCount = await unselectedModels.count();

        if (unselectedCount > 0) {
          // Dimmed models should have pointer-events-none
          await expect(unselectedModels.first()).toHaveClass(/opacity-40/);
        }
      });

      await test.step('deselect one model — dimming lifts', async () => {
        const modal = authenticatedPage.getByTestId('model-selector-modal');
        const selectedItems = modal.locator('[data-testid^="model-item-"][data-selected="true"]');
        await selectedItems.last().getByTestId('model-checkbox').click();

        // Previously dimmed models should no longer be dimmed
        const unselected = modal.locator(
          '[data-testid^="model-item-"][data-selected="false"]:not(:has([data-testid="lock-icon"]))'
        );
        const count = await unselected.count();
        if (count > 0) {
          await expect(unselected.first()).not.toHaveClass(/opacity-40/);
        }

        await chatPage.confirmModelSelection();
      });
    });

    test('modal opens with current selections checked', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models and close modal', async () => {
        await chatPage.selectModels(3);
      });

      await test.step('reopen modal — same 3 have checkmarks', async () => {
        await chatPage.openModelSelector();
        const selectedCount = await chatPage.getSelectedModelCount();
        expect(selectedCount).toBe(3);
        await chatPage.confirmModelSelection();
      });
    });

    test('clear selected removes all selections', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 3 models', async () => {
        await chatPage.selectModels(3);
        await chatPage.expectComparisonBarVisible();
      });

      await test.step('reopen modal, clear, select 1 model, confirm', async () => {
        await chatPage.openModelSelector();
        await authenticatedPage.getByTestId('clear-selection-button').click();
        await authenticatedPage.waitForTimeout(100);
        // With 0 selected, Close reverts — select 1 model in the already-open modal
        const modal = authenticatedPage.getByTestId('model-selector-modal');
        const firstNonPremium = modal.locator(
          '[data-testid^="model-item-"]:not(:has([data-testid="lock-icon"]))'
        );
        await firstNonPremium.first().getByTestId('model-checkbox').click();
        await chatPage.confirmModelSelection();
      });

      await test.step('verify single model in header, no comparison bar', async () => {
        await chatPage.expectComparisonBarHidden();
        const button = authenticatedPage.getByTestId('model-selector-button');
        await expect(button).not.toContainText('Multiple Models');
      });
    });

    test('persists selection across page reload', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 2 models', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectComparisonBarVisible();
      });

      await test.step('reload page', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForAppStable();
      });

      await test.step('verify 2 models still selected', async () => {
        await chatPage.expectComparisonBarVisible();
        const count = await chatPage.getComparisonBarModelCount();
        expect(count).toBe(2);
      });
    });
  });

  test.describe('Multi-Model Streaming', () => {
    test('sends to multiple models and receives parallel responses', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 2 models and send message', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectComparisonBarVisible();

        const testMessage = `Multi-stream test ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(testMessage);
        await chatPage.waitForConversation();
      });

      await test.step('verify 2 AI responses appear', async () => {
        await chatPage.waitForMultiModelResponses(2);
      });
    });

    test('each AI response shows model nametag', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      await test.step('verify all AI messages have nametags', async () => {
        await chatPage.expectAllAIMessagesHaveNametag();
      });

      await test.step('verify nametags show different model names', async () => {
        const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
        const count = await assistantMessages.count();
        expect(count).toBe(2);

        const nametag1 = await assistantMessages.nth(0).getByTestId('model-nametag').textContent();
        const nametag2 = await assistantMessages.nth(1).getByTestId('model-nametag').textContent();
        // The 2 models selected by fixture should have different names
        expect(nametag1).not.toBe(nametag2);
      });
    });

    test('displays cost per model response', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      const chatPage = new ChatPage(authenticatedPage);

      const costElements = chatPage.messageList.locator('[data-testid="message-cost"]');
      const count = await costElements.count();
      // Each AI response should have its own cost
      expect(count).toBeGreaterThanOrEqual(2);
    });

    test('follow-up message includes all previous responses in history', async ({
      authenticatedPage,
      multiModelConversation: _multiModelConversation,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);

      await test.step('send follow-up message', async () => {
        const followup = `Follow-up ${String(Date.now())}`;
        await chatPage.sendFollowUpMessage(followup);
        await chatPage.expectMessageVisible(followup);
      });

      await test.step('wait for 2 more AI responses (4 total)', async () => {
        // Wait for streaming to complete — cost badge signals billing + persistence done
        await chatPage.waitForStreamComplete(20_000);
        // Verify follow-up generated 2 AI responses (visible at the bottom of the list)
        // Use unsettledExpect — the settled indicator may fire before Virtuoso renders
        const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
        await unsettledExpect(assistantMessages).toHaveCount(4, { timeout: 20_000 });
      });
    });
  });

  test.describe('Multi-Model on Fork', () => {
    test('multi-model responses persist on fork after streaming completes', async ({
      authenticatedPage,
    }) => {
      test.slow();
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('send single-model message and create fork', async () => {
        const setupMsg = `Fork setup ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(setupMsg);
        await chatPage.waitForConversation();
        await chatPage.waitForAIResponse(setupMsg);

        // Fork from the AI response → Fork 1 active
        await chatPage.clickFork(1);
        await chatPage.expectForkTabCount(2);
        await chatPage.expectActiveForkTab('Fork 1');
      });

      await test.step('select 2 models and send message on fork', async () => {
        await chatPage.selectModels(2);
        await chatPage.expectComparisonBarVisible();

        const forkMsg = `Multi-model on fork ${String(Date.now())}`;
        await chatPage.sendFollowUpMessage(forkMsg);
        await chatPage.expectMessageVisible(forkMsg);
      });

      await test.step('verify both AI responses visible after stream completes', async () => {
        // Wait for ALL 3 cost badges (1 setup + 2 multi-model).
        // Cost badges appear after: done SSE → saveChatTurn committed → invalidateQueries refetched.
        // This guarantees persistence before reload. Using waitForStreamComplete alone is
        // insufficient here — it finds the setup AI's pre-existing cost badge immediately.
        const costBadges = chatPage.messageList.locator('[data-testid="message-cost"]');
        await unsettledExpect(costBadges).toHaveCount(3, { timeout: 20_000 });

        const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
        await unsettledExpect(assistantMessages).toHaveCount(3, { timeout: 15_000 });
      });

      await test.step('verify distinct model nametags on multi-model responses', async () => {
        const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
        const count = await assistantMessages.count();
        // Last 2 should have different model nametags
        const nametag1 = await assistantMessages
          .nth(count - 2)
          .getByTestId('model-nametag')
          .textContent();
        const nametag2 = await assistantMessages
          .nth(count - 1)
          .getByTestId('model-nametag')
          .textContent();
        expect(nametag1).not.toBe(nametag2);
      });

      await test.step('page reload preserves all responses on fork', async () => {
        await authenticatedPage.reload();
        await chatPage.waitForConversationLoaded();

        // Fork 1 should still be active
        await chatPage.expectActiveForkTab('Fork 1');

        // All 3 assistant messages should still be visible
        const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
        await unsettledExpect(assistantMessages).toHaveCount(3, { timeout: 15_000 });
      });
    });
  });

  test.describe('Single-Model Regression', () => {
    test('single model selection works identically to before', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await test.step('select 1 model — no comparison bar', async () => {
        await chatPage.selectModels(1);
        await chatPage.expectComparisonBarHidden();
      });

      await test.step('send message — 1 response, normal flow', async () => {
        const testMessage = `Single model ${String(Date.now())}`;
        await chatPage.sendNewChatMessage(testMessage);
        await chatPage.waitForConversation();
        await chatPage.waitForAIResponse();
        await chatPage.expectAssistantMessageContains('Echo:');
      });
    });
  });

  test.describe('Partial Failure', () => {
    test('handles partial model failure gracefully', async ({ authenticatedPage }) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      // Step 1: Select first + LAST non-premium models (isolates fail target from other tests)
      const { successModelId, failModelId } = await chatPage.selectModelsWithFailTarget();
      await chatPage.expectComparisonBarVisible();

      // Step 2: Configure the last model to fail
      await authenticatedPage.request.post(`${apiUrl}/api/dev/fail-model`, {
        data: { modelId: failModelId },
      });

      try {
        // Step 3: Send message
        await chatPage.sendNewChatMessage(`Partial failure test ${String(Date.now())}`);
        await chatPage.waitForConversation();

        // Step 4: Wait for stream to complete and verify successful model
        await chatPage.waitForStreamComplete();

        const successResponse = authenticatedPage
          .locator('[data-role="assistant"]')
          .filter({ hasText: 'Echo:' });
        await expect(successResponse.first()).toBeVisible({ timeout: 15_000 });

        // Step 5: Verify failed model shows error message
        // Error renders on an optimistic message after stream ends — opt out of settled
        // to wait for the React re-render without premature failure
        const errorMessage = authenticatedPage.getByTestId('model-error-message');
        await unsettledExpect(errorMessage).toBeVisible({ timeout: 10_000 });
        await unsettledExpect(errorMessage).toContainText(/something went wrong/i);

        // Step 6: Verify billing via API — only successful model persisted
        const conversationUrl = authenticatedPage.url();
        const conversationId = conversationUrl.split('/chat/')[1]?.split('?')[0];
        expect(conversationId).toBeTruthy();

        const apiResponse = await authenticatedPage.request.get(
          `${apiUrl}/api/conversations/${conversationId!}`
        );
        expect(apiResponse.ok()).toBe(true);
        const { messages } = (await apiResponse.json()) as {
          messages: { senderType: string; modelName: string | null; cost: string | null }[];
        };

        const aiMessages = messages.filter((m) => m.senderType === 'ai');
        // Only the successful model should have a persisted message
        const successfulAiMessages = aiMessages.filter((m) => m.cost !== null && m.cost !== '0');
        expect(successfulAiMessages.length).toBe(1);
        expect(successfulAiMessages[0]!.modelName).toBe(successModelId);

        // No persisted message for the failed model
        const failedModelMessages = aiMessages.filter((m) => m.modelName === failModelId);
        expect(failedModelMessages.length).toBe(0);

        // Step 7: Verify chat still usable
        await expect(chatPage.messageInput).toBeVisible();
      } finally {
        // Cleanup: clear failing models
        await authenticatedPage.request.post(`${apiUrl}/api/dev/fail-model`, {
          data: { modelId: null },
        });
      }
    });
  });
});
