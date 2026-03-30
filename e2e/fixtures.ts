import { existsSync } from 'node:fs';
import {
  test as base,
  expect as rawExpect,
  type Browser,
  type BrowserContext,
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
  storageState: StorageState,
  label: string
): (
  deps: { browser: Browser },
  use: (page: Page) => Promise<void>,
  testInfo: TestInfo
) => Promise<void> {
  return async ({ browser }, use, testInfo) => {
    const harPath = testInfo.outputPath(`${label}.har`);
    const context = await browser.newContext({
      storageState,
      recordHar: {
        path: harPath,
        mode: 'minimal',
        urlFilter: /\/api\//,
      },
    });
    const page = await context.newPage();
    const { errors, cleanup } = attachConsoleErrors(page);
    await use(page);

    const failed = testInfo.status !== testInfo.expectedStatus;

    if (failed && errors.length > 0) {
      await testInfo.attach(`console-errors-${label}`, {
        body: errors.join('\n'),
        contentType: 'text/plain',
      });
    }

    if (failed) {
      const snapshot = await page.locator(':root').ariaSnapshot();
      if (snapshot) {
        await testInfo.attach(`page-snapshot-${label}`, {
          body: snapshot,
          contentType: 'text/yaml',
        });
      }
    }

    cleanup();
    await context.close();

    if (failed && existsSync(harPath)) {
      await testInfo.attach(`har-${label}`, { path: harPath, contentType: 'application/json' });
    }
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
  /** Factory for creating fresh, fully-instrumented browser contexts on demand.
   *  Each page gets HAR recording, console error capture, and page snapshot on failure.
   *  Defaults to empty storage state (unauthenticated). Pass a storage state path for auth. */
  createPage: (storageState?: StorageState) => Promise<Page>;
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
  billingTokenRequest: APIRequestContext;
  // Group chat fixtures
  groupConversation: GroupConversation;
  testBobPage: Page;
  testDavePage: Page;
  testBobRequest: APIRequestContext;
}

async function teardownPage(
  entry: {
    page: Page;
    context: BrowserContext;
    label: string;
    errors: string[];
    cleanup: () => void;
    harPath: string;
  },
  failed: boolean,
  testInfo: TestInfo
): Promise<void> {
  if (failed && entry.errors.length > 0) {
    await testInfo.attach(`console-errors-${entry.label}`, {
      body: entry.errors.join('\n'),
      contentType: 'text/plain',
    });
  }
  if (failed) {
    const snapshot = await entry.page
      .locator(':root')
      .ariaSnapshot()
      .catch(() => null);
    if (snapshot) {
      await testInfo.attach(`page-snapshot-${entry.label}`, {
        body: snapshot,
        contentType: 'text/yaml',
      });
    }
  }
  entry.cleanup();
  await entry.context.close();
  if (failed && existsSync(entry.harPath)) {
    await testInfo.attach(`har-${entry.label}`, {
      path: entry.harPath,
      contentType: 'application/json',
    });
  }
}

export const test = base.extend<CustomFixtures>({
  authenticatedPage: createPageFixture('e2e/.auth/test-alice.json', 'authenticatedPage'),

  // Explicitly clear storage state to override project-level default auth
  unauthenticatedPage: createPageFixture({ cookies: [], origins: [] }, 'unauthenticatedPage'),

  // Factory for creating fresh, instrumented pages on demand.
  // Each page gets the same HAR/console-error/snapshot capture as named fixtures.
  createPage: async ({ browser }, use, testInfo) => {
    const pages: {
      page: Page;
      context: BrowserContext;
      label: string;
      errors: string[];
      cleanup: () => void;
      harPath: string;
    }[] = [];
    let counter = 0;

    const DEFAULT_STORAGE_STATE: StorageState = { cookies: [], origins: [] };
    const factory = async (storageState: StorageState = DEFAULT_STORAGE_STATE): Promise<Page> => {
      counter++;
      const label = `unauthenticatedPage-${String(counter)}`;
      const harPath = testInfo.outputPath(`${label}.har`);
      const context = await browser.newContext({
        storageState,
        recordHar: { path: harPath, mode: 'minimal', urlFilter: /\/api\// },
      });
      const page = await context.newPage();
      const { errors, cleanup } = attachConsoleErrors(page);
      pages.push({ page, context, label, errors, cleanup, harPath });
      return page;
    };

    await use(factory);

    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const entry of pages) {
      await teardownPage(entry, failed, testInfo);
    }
  },

  authenticatedRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: 'e2e/.auth/test-alice.json',
    });
    await use(context);
    await context.dispose();
  },

  // 2FA test user (has TOTP enabled)
  test2FAPage: createPageFixture('e2e/.auth/test-2fa.json', 'test2FAPage'),

  // Dedicated billing test users (isolated balance state between tests)
  billingSuccessPage: createPageFixture(
    'e2e/.auth/test-billing-success.json',
    'billingSuccessPage'
  ),
  billingSuccessPage2: createPageFixture(
    'e2e/.auth/test-billing-success-2.json',
    'billingSuccessPage2'
  ),
  billingFailurePage: createPageFixture(
    'e2e/.auth/test-billing-failure.json',
    'billingFailurePage'
  ),
  billingValidationPage: createPageFixture(
    'e2e/.auth/test-billing-validation.json',
    'billingValidationPage'
  ),
  billingDevModePage: createPageFixture(
    'e2e/.auth/test-billing-devmode.json',
    'billingDevModePage'
  ),

  // Billing token test user (isolated balance for token-login billing portal tests)
  billingTokenRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: 'e2e/.auth/test-billing-token.json',
    });
    await use(context);
    await context.dispose();
  },

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
  testBobPage: createPageFixture('e2e/.auth/test-bob.json', 'testBobPage'),

  // Browser context logged in as test-dave (verified, no group membership by default)
  testDavePage: createPageFixture('e2e/.auth/test-dave.json', 'testDavePage'),

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
      await chatPage.waitForStreamComplete();

      const url = new URL(authenticatedPage.url());
      const id = url.pathname.split('/').pop() ?? '';

      await use({ id, url: authenticatedPage.url() });
    },
    { timeout: 60_000 },
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

export { expect, unsettledExpect } from './helpers/settled-expect.js';
