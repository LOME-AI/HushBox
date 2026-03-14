import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';

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

      await test.step('reopen modal and click Clear Selected', async () => {
        await chatPage.openModelSelector();
        await authenticatedPage.getByTestId('clear-selection-button').click();
      });

      await test.step('verify 0 models selected in modal and confirm', async () => {
        await expect(async () => {
          const selectedCount = await chatPage.getSelectedModelCount();
          expect(selectedCount).toBe(0);
        }).toPass({ timeout: 5000 });
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
        await chatPage.waitForMultiModelResponses(4, 20_000);
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
    test('handles partial model failure gracefully', ({ authenticatedPage: _page }) => {
      test.skip(true, 'Requires dev endpoint to simulate model failure');
    });
  });
});
