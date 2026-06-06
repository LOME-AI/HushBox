import { test, expect } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from '../pages/index.js';

test.describe('Model Nametag', () => {
  test('shows model name on every AI response', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify AI message has a model nametag', async () => {
      await chatPage.expectAllAIMessagesHaveNametag();
    });
  });

  test('nametag persists after page reload', async ({ authenticatedPage, testConversation }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify nametag is visible', async () => {
      await chatPage.expectAllAIMessagesHaveNametag();
    });

    const assistantMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
    const nametagBefore =
      (await assistantMessage.getByTestId(TEST_IDS.modelNametag).textContent()) ?? '';

    await test.step('reload page', async () => {
      await authenticatedPage.goto(`/chat/${testConversation.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await chatPage.waitForConversationLoaded();
    });

    await test.step('verify nametag still shows same model name', async () => {
      await chatPage.expectAllAIMessagesHaveNametag();
      const nametagAfter = assistantMessage.getByTestId(TEST_IDS.modelNametag);
      await expect(nametagAfter).toHaveText(nametagBefore);
    });
  });

  test('multi-model responses each show distinct nametag', async ({
    authenticatedPage,
    multiModelConversation: _multiModelConversation,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);

    await test.step('verify all AI messages have nametags', async () => {
      await chatPage.expectAllAIMessagesHaveNametag();
    });

    await test.step('verify different nametag text per model', async () => {
      // Assert React-state count via countMessages (virtualization-safe).
      expect(await chatPage.countMessages('assistant')).toBe(2);

      // For index-based iteration use DOM count — avoid iterating past the
      // DOM end under virtualization (the 2 multi-model responses are newest
      // and always rendered, so this matches state count in practice).
      const assistantMessages = chatPage.messageList.locator('[data-role="assistant"]');
      const domCount = await assistantMessages.count();
      const names = new Set<string>();
      for (let index = 0; index < domCount; index++) {
        const text = await assistantMessages
          .nth(index)
          .getByTestId(TEST_IDS.modelNametag)
          .textContent();
        if (text) names.add(text);
      }
      expect(names.size).toBe(domCount);
    });
  });
});
