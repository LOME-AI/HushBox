import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

// All guest chat tests share localhost IP for rate limiting - run only on chromium, serially
test.describe('Guest Chat', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(
        true,
        'Guest chat tests run only on chromium to avoid IP-based rate limit interference'
      );
    }
  });

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const response = await request.delete('http://localhost:8787/api/dev/guest-usage');
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
    test('guest can send message and receive response', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const testMessage = `Guest test ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);

      await expect(unauthenticatedPage).toHaveURL('/chat/guest');
      await expect(chatPage.messageList).toBeVisible({ timeout: 5000 });
      await chatPage.expectMessageVisible(testMessage);
      await chatPage.waitForAIResponse();
      await chatPage.expectAssistantMessageContains('Echo:');

      await expect(chatPage.messageInput).toBeVisible();
      await expect(chatPage.messageInput).toBeEnabled();
    });

    test('guest can have multi-turn conversation', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.goto();
      await chatPage.selectNonPremiumModel();

      const firstMessage = `Guest first ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(firstMessage);
      await expect(chatPage.messageList).toBeVisible({ timeout: 5000 });
      await chatPage.waitForAIResponse();

      const secondMessage = `Guest second ${String(Date.now())}`;
      await chatPage.sendFollowUpMessage(secondMessage);
      await chatPage.expectMessageVisible(secondMessage);
    });
  });

  test.describe('Rate Limiting', () => {
    test.beforeEach(async ({ request }) => {
      const response = await request.delete('http://localhost:8787/api/dev/guest-usage');
      expect(response.ok()).toBe(true);
    });

    test('shows signup modal after 5 messages', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      const signupModal = unauthenticatedPage.getByTestId('signup-modal');

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

      await expect(signupModal).toBeVisible({ timeout: 10_000 });
      const heading = signupModal.getByRole('heading');
      await expect(heading).toContainText(/continue chatting/i);
      await expect(signupModal.getByText(/5 free messages/i)).toBeVisible();
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

      const signupModal = unauthenticatedPage.getByTestId('signup-modal');
      await expect(signupModal).toBeVisible({ timeout: 10_000 });
      await unauthenticatedPage.keyboard.press('Escape');

      await expect(chatPage.messageInput).toBeDisabled();
      await expect(unauthenticatedPage.getByText(/You've used all 5 free messages/i)).toBeVisible();
    });
  });

  test.describe('Premium Model Access', () => {
    test('shows signup modal when guest clicks premium model', async ({ unauthenticatedPage }) => {
      const chatPage = new ChatPage(unauthenticatedPage);
      const signupModal = unauthenticatedPage.getByTestId('signup-modal');

      await chatPage.goto();

      const modelSelector = unauthenticatedPage.getByTestId('model-selector-button');
      await modelSelector.click();

      const premiumModel = unauthenticatedPage
        .getByTestId('model-selector-modal')
        .locator('[data-testid^="model-item-"]:has([data-testid="lock-icon"])')
        .first();
      await premiumModel.dblclick();

      await expect(signupModal).toBeVisible({ timeout: 3000 });
      const heading = signupModal.getByRole('heading');
      await expect(heading).toContainText(/premium/i);
    });
  });
});
