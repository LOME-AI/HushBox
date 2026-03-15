import {
  test as base,
  expect as rawExpect,
  type Browser,
  type Page,
  type APIRequestContext,
  type TestInfo,
} from '@playwright/test';
import { expect } from './helpers/settled-expect.js';
import { ChatPage } from './pages';
import { requireEnv } from './helpers/env.js';

const apiUrl = requireEnv('VITE_API_URL');

function attachConsoleErrors(page: Page): { errors: string[]; cleanup: () => void } {
  const errors: string[] = [];
  const onConsole = (msg: { type: () => string; text: () => string }): void => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  const onPageError = (err: Error): void => {
    errors.push(`[UNCAUGHT] ${err.message}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    errors,
    cleanup: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

type StorageState = string | { cookies: []; origins: [] };

function createPageFixture(
  storageState: StorageState
): (
  deps: { browser: Browser },
  use: (page: Page) => Promise<void>,
  testInfo: TestInfo
) => Promise<void> {
  return async ({ browser }, use, testInfo) => {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    const { errors, cleanup } = attachConsoleErrors(page);
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus && errors.length > 0) {
      await testInfo.attach('console-errors', {
        body: errors.join('\n'),
        contentType: 'text/plain',
      });
    }
    cleanup();
    await context.close();
  };
}

interface TestConversation {
  id: string;
  url: string;
}

interface GroupConversation {
  id: string;
  members: { userId: string; username: string; email: string }[];
}

interface MultiModelConversation {
  id: string;
  url: string;
}

interface CustomFixtures {
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  testConversation: TestConversation;
  multiModelConversation: MultiModelConversation;
  authenticatedRequest: APIRequestContext;
  // 2FA test user (has TOTP enabled)
  test2FAPage: Page;
  // Dedicated billing test users (isolated balance state)
  billingSuccessPage: Page;
  billingSuccessPage2: Page;
  billingFailurePage: Page;
  billingValidationPage: Page;
  billingDevModePage: Page;
  // Group chat fixtures
  groupConversation: GroupConversation;
  testBobPage: Page;
  testDavePage: Page;
  testBobRequest: APIRequestContext;
}

export const test = base.extend<CustomFixtures>({
  authenticatedPage: createPageFixture('e2e/.auth/test-alice.json'),

  // Explicitly clear storage state to override project-level default auth
  unauthenticatedPage: createPageFixture({ cookies: [], origins: [] }),

  authenticatedRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: 'e2e/.auth/test-alice.json',
    });
    await use(context);
    await context.dispose();
  },

  // 2FA test user (has TOTP enabled)
  test2FAPage: createPageFixture('e2e/.auth/test-2fa.json'),

  // Dedicated billing test users (isolated balance state between tests)
  billingSuccessPage: createPageFixture('e2e/.auth/test-billing-success.json'),
  billingSuccessPage2: createPageFixture('e2e/.auth/test-billing-success-2.json'),
  billingFailurePage: createPageFixture('e2e/.auth/test-billing-failure.json'),
  billingValidationPage: createPageFixture('e2e/.auth/test-billing-validation.json'),
  billingDevModePage: createPageFixture('e2e/.auth/test-billing-devmode.json'),

  // Group chat: creates conversation with seeded messages via dev endpoint
  groupConversation: async (
    { authenticatedPage: _authenticatedPage, authenticatedRequest },
    use
  ) => {
    const response = await authenticatedRequest.post('/api/dev/group-chat', {
      data: {
        ownerEmail: 'test-alice@test.hushbox.ai',
        memberEmails: ['test-bob@test.hushbox.ai'],
        messages: [
          {
            senderEmail: 'test-alice@test.hushbox.ai',
            content: 'Hello from Alice',
            senderType: 'user',
          },
          { content: 'Echo: Hello! How can I help?', senderType: 'ai' },
          { senderEmail: 'test-bob@test.hushbox.ai', content: 'Hi from Bob', senderType: 'user' },
          {
            senderEmail: 'test-alice@test.hushbox.ai',
            content: 'Alice replies',
            senderType: 'user',
          },
          {
            senderEmail: 'test-alice@test.hushbox.ai',
            content: 'Summarize this',
            senderType: 'user',
          },
          { content: 'Echo: Here is a summary of your conversation.', senderType: 'ai' },
        ],
      },
    });

    rawExpect(response.ok(), `group-chat creation failed: ${String(response.status())}`).toBe(true);
    const data = (await response.json()) as {
      conversationId: string;
      members: GroupConversation['members'];
    };
    await use({ id: data.conversationId, members: data.members });
    // No cleanup — CI database is ephemeral. Deleting here races with deferred
    // saveChatTurn() running via Wrangler's waitUntil(), producing billing_failed errors.
  },

  // Second browser context logged in as test-bob
  testBobPage: createPageFixture('e2e/.auth/test-bob.json'),

  // Browser context logged in as test-dave (verified, no group membership by default)
  testDavePage: createPageFixture('e2e/.auth/test-dave.json'),

  // API request context for test-bob (used for owner-privilege budget operations)
  testBobRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: 'e2e/.auth/test-bob.json',
    });
    await use(context);
    await context.dispose();
  },

  multiModelConversation: [
    async ({ authenticatedPage }, use) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      // Select 2 non-premium models
      await chatPage.selectModels(2);
      await chatPage.expectComparisonBarVisible();

      // Send first message and wait for both responses
      const testMessage = `Multi-model fixture ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);
      await chatPage.waitForConversation();
      await chatPage.waitForMultiModelResponses(2);

      const url = new URL(authenticatedPage.url());
      const id = url.pathname.split('/').pop() ?? '';

      await use({ id, url: authenticatedPage.url() });
    },
    { timeout: 30_000 },
  ],

  testConversation: async (
    { authenticatedPage, authenticatedRequest: _authenticatedRequest },
    use
  ) => {
    const page = authenticatedPage;
    await page.goto('/chat');

    // Wait for app to stabilize (auth + balance loaded) before interacting
    await page.locator('[data-app-stable="true"]').waitFor({ state: 'visible', timeout: 15_000 });

    const testMessage = `Fixture setup ${String(Date.now())}`;
    const input = page.getByRole('textbox', { name: 'Ask me anything...' });
    await input.fill(testMessage);

    const sendButton = page.getByRole('button', { name: 'Send' });
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    await sendButton.click();

    // Wait for navigation to conversation page first (happens on successful message send)
    await expect(page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout: 20_000 });

    // Then wait for the Echo response to appear
    const echoMessage = page.getByRole('log', { name: 'Chat messages' }).getByText('Echo:');
    await expect(echoMessage).toBeVisible({ timeout: 15_000 });

    const url = new URL(page.url());
    const id = url.pathname.split('/').pop() ?? '';

    await use({ id, url: page.url() });
    // No cleanup — CI database is ephemeral. Deleting here races with deferred
    // saveChatTurn() running via Wrangler's waitUntil(), producing billing_failed errors.
  },
});

export { expect } from './helpers/settled-expect.js';
