import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

// All trial chat tests share localhost IP for rate limiting - run only on chromium, serially
test.describe('Trial Chat', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(
        true,
        'Trial chat tests run only on chromium to avoid IP-based rate limit interference'
      );
    }
  });

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const response = await request.delete('http://localhost:8787/api/dev/trial-usage');
    expect(response.ok()).toBe(true);
  });
  test.describe('New Chat Page', () => {
    test('displays new chat UI with focused prompt input', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();

      await chatPage.expectNewChatPageVisible();
      await chatPage.expectPromptInputVisible();
      await chatPage.expectSuggestionChipsVisible();

      await expect(chatPage.promptInput).toBeEnabled({ timeout: 3000 });
      await expect(chatPage.promptInput).toBeFocused({ timeout: 1000 });
    });
  });

  test.describe('Chat Streaming', () => {
    test('trial user can send message and receive response', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const testMessage = `Trial test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await expect(unauthenticatedPage).toHaveURL('/chat/trial');
      await expect(chatPage.messageList).toBeVisible({ timeout: 5000 });
      await chatPage.expectMessageVisible(testMessage);
      await chatPage.waitForAIResponse();
      await chatPage.expectAssistantMessageContains('Echo:');

      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageInput).toBeEnabled();
    });

    test('trial user can have multi-turn conversation', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const firstMessage = `Trial first ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(firstMessage);
      await expect(chatPage.messageList).toBeVisible({ timeout: 5000 });
      await chatPage.waitForAIResponse();

      const secondMessage = `Trial second ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(secondMessage);
      await chatPage.expectMessageVisible(secondMessage);
    });
  });

  test.describe('Rate Limiting', () => {
    test.beforeEach(async ({ request }) => {
      const response = await request.delete('http://localhost:8787/api/dev/trial-usage');
      expect(response.ok()).toBe(true);
    });

    test('shows rate limit message after 5 messages', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      for (let index = 1; index <= 5; index++) {
        const message = `Rate limit test ${String(index)} ${String(Date.now())}`;
        if (index === 1) {
          await chatPage.sendNewChatMessage(message);
          await expect(chatPage.messageList).toBeVisible({ timeout: 5000 });
        } else {
          await chatPage.sendFollowUpMessage(message);
        }
        await chatPage.waitForAIResponse(message, 30_000);
      }

      // Don't use sendFollowUpMessage - rate limiting prevents input from clearing
      const rateLimitMessage = `Rate limit trigger ${String(Date.now())}`;
      await chatPage.messageInput.fill(rateLimitMessage);
      await chatPage.messageInput.press('Enter');

      // Rate limit shows inline message instead of modal
      await expect(unauthenticatedPage.getByText(/5 free messages/i)).toBeVisible({
        timeout: 10_000,
      });
      await expect(unauthenticatedPage.getByText(/continue chatting/i)).toBeVisible();
    });

    test('input is disabled after rate limit', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);

      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      for (let index = 1; index <= 5; index++) {
        const message = `Disable test ${String(index)} ${String(Date.now())}`;
        if (index === 1) {
          await chatPage.sendNewChatMessage(message);
          await expect(chatPage.messageList).toBeVisible({ timeout: 5000 });
        } else {
          await chatPage.sendFollowUpMessage(message);
        }
        await chatPage.waitForAIResponse(message, 30_000);
      }

      // Don't use sendFollowUpMessage - rate limiting prevents input from clearing
      const rateLimitMessage = `Disable trigger ${String(Date.now())}`;
      await chatPage.messageInput.fill(rateLimitMessage);
      await chatPage.messageInput.press('Enter');

      // Rate limit message appears inline and input is disabled
      await expect(unauthenticatedPage.getByText(/You've used all 5 free messages/i)).toBeVisible({
        timeout: 10_000,
      });
      await expect(chatPage.messageInput).toBeDisabled();
    });
  });

  test.describe('Premium Model Access', () => {
    test('shows signup modal when trial user clicks premium model', async ({
      unauthenticatedPage,
    }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      const signupModal = unauthenticatedPage.getByTestId('signup-modal');

      await chatPage.goto();

      const modelSelector = unauthenticatedPage.getByTestId('model-selector-button');
      await expect(modelSelector).toBeVisible({ timeout: 10_000 });
      await modelSelector.click();

      const modal = unauthenticatedPage.getByTestId('model-selector-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Wait for models to load (at least one premium model with lock icon)
      const premiumModel = modal
        .locator('[data-testid^="model-item-"]:has([data-testid="lock-icon"])')
        .first();
      await expect(premiumModel).toBeVisible({ timeout: 10_000 });
      await premiumModel.dblclick();

      await expect(signupModal).toBeVisible({ timeout: 3000 });
      const heading = signupModal.getByRole('heading');
      await expect(heading).toContainText(/premium/i);
    });
  });
});
