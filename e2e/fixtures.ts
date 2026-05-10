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
    const isRetry = testInfo.retry > 0;
    const context = await browser.newContext({
      storageState,
      ...(isRetry && {
        recordHar: {
          path: harPath,
          mode: 'minimal',
          urlFilter: /\/api\//,
        },
      }),
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

    if (failed && isRetry && existsSync(harPath)) {
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

interface MediaConversation {
  conversationId: string;
  assistantMessageId: string;
  page: Page;
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
  /** Authenticated conversation with one finished image generation. */
  imageConversation: MediaConversation;
  /** Authenticated conversation with one finished video generation. */
  videoConversation: MediaConversation;
  /** Authenticated low-balance user (~$0.01) for affordability error testing. */
  lowBalancePage: Page;
  authenticatedRequest: APIRequestContext;
  test2FAPage: Page;
  billingSuccessPage: Page;
  billingSuccessPage2: Page;
  billingFailurePage: Page;
  billingValidationPage: Page;
  billingDevModePage: Page;
  billingTokenRequest: APIRequestContext;
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
    const isRetry = testInfo.retry > 0;
    const factory = async (storageState: StorageState = DEFAULT_STORAGE_STATE): Promise<Page> => {
      counter++;
      const label = `unauthenticatedPage-${String(counter)}`;
      const harPath = testInfo.outputPath(`${label}.har`);
      const context = await browser.newContext({
        storageState,
        ...(isRetry && {
          recordHar: { path: harPath, mode: 'minimal', urlFilter: /\/api\// },
        }),
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

  test2FAPage: createPageFixture('e2e/.auth/test-2fa.json', 'test2FAPage'),

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

  billingTokenRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: 'e2e/.auth/test-billing-token.json',
    });
    await use(context);
    await context.dispose();
  },

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

  testBobPage: createPageFixture('e2e/.auth/test-bob.json', 'testBobPage'),

  testDavePage: createPageFixture('e2e/.auth/test-dave.json', 'testDavePage'),

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

      await chatPage.selectModels(2);
      await chatPage.expectComparisonBarVisible();

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

  imageConversation: [
    async ({ authenticatedPage }, use) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      await chatPage.switchToImageMode();
      const prompt = `Image fixture ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(prompt);
      await chatPage.waitForConversation();
      await chatPage.expectImageVisible();
      await chatPage.waitForStreamComplete();

      const url = new URL(authenticatedPage.url());
      const conversationId = url.pathname.split('/').pop() ?? '';

      const assistantMessageId =
        (await authenticatedPage
          .locator('[data-role="assistant"]')
          .first()
          .getAttribute('data-message-id')) ?? '';
      rawExpect(assistantMessageId, 'imageConversation: missing assistant message id').not.toBe('');

      await use({ conversationId, assistantMessageId, page: authenticatedPage });
    },
    { timeout: 60_000 },
  ],

  videoConversation: [
    async ({ authenticatedPage }, use) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      await chatPage.switchToVideoMode();
      const prompt = `Video fixture ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(prompt);
      await chatPage.waitForConversation();
      await chatPage.expectVideoVisible();
      await chatPage.waitForStreamComplete();

      const url = new URL(authenticatedPage.url());
      const conversationId = url.pathname.split('/').pop() ?? '';

      const assistantMessageId =
        (await authenticatedPage
          .locator('[data-role="assistant"]')
          .first()
          .getAttribute('data-message-id')) ?? '';
      rawExpect(assistantMessageId, 'videoConversation: missing assistant message id').not.toBe('');

      await use({ conversationId, assistantMessageId, page: authenticatedPage });
    },
    { timeout: 60_000 },
  ],

  // Low-balance page: authenticated as test-billing-validation (zero starting balance);
  // wallet is set to $0.01 via the dev endpoint before the test runs so any
  // image/video generation triggers the insufficient-balance preflight error.
  // Reset to $0 after the test to avoid bleed.
  lowBalancePage: async ({ browser, playwright }, use, testInfo) => {
    const lowBalanceEmail = 'test-billing-validation@test.hushbox.ai';
    const requestContext = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: 'e2e/.auth/test-billing-validation.json',
    });

    // Set free-tier balance to a tiny amount so the preflight rejects media generation.
    await requestContext.post('/api/dev/wallet-balance', {
      data: { email: lowBalanceEmail, walletType: 'purchased', balance: '0.01000000' },
    });
    await requestContext.post('/api/dev/wallet-balance', {
      data: { email: lowBalanceEmail, walletType: 'free_tier', balance: '0.00000000' },
    });

    const harPath = testInfo.outputPath('lowBalancePage.har');
    const isRetry = testInfo.retry > 0;
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-billing-validation.json',
      ...(isRetry && {
        recordHar: { path: harPath, mode: 'minimal', urlFilter: /\/api\// },
      }),
    });
    const page = await context.newPage();
    const { errors, cleanup } = attachConsoleErrors(page);
    await use(page);

    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed && errors.length > 0) {
      await testInfo.attach(`console-errors-lowBalancePage`, {
        body: errors.join('\n'),
        contentType: 'text/plain',
      });
    }
    if (failed) {
      const snapshot = await page
        .locator(':root')
        .ariaSnapshot()
        .catch(() => null);
      if (snapshot) {
        await testInfo.attach(`page-snapshot-lowBalancePage`, {
          body: snapshot,
          contentType: 'text/yaml',
        });
      }
    }

    cleanup();
    await context.close();

    if (failed && isRetry && existsSync(harPath)) {
      await testInfo.attach(`har-lowBalancePage`, {
        path: harPath,
        contentType: 'application/json',
      });
    }

    await requestContext.post('/api/dev/wallet-balance', {
      data: { email: lowBalanceEmail, walletType: 'purchased', balance: '0.00000000' },
    });
    await requestContext.dispose();
  },

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use) => {
    const testMessage = `Fixture setup ${String(Date.now())}`;
    const response = await authenticatedRequest.post('/api/dev/conversation', {
      data: {
        ownerEmail: 'test-alice@test.hushbox.ai',
        messages: [
          { content: testMessage, senderType: 'user' },
          { content: `Echo: ${testMessage}`, senderType: 'ai' },
        ],
      },
    });

    rawExpect(response.ok(), `conversation creation failed: ${String(response.status())}`).toBe(
      true
    );
    const data = (await response.json()) as { conversationId: string };
    const id = data.conversationId;

    // Navigate to the conversation so the page is ready for test interactions.
    // Wait for both seeded messages to render — waitForConversationLoaded only
    // waits for the first message-item, which can resolve on just the user
    // message while the AI reply is still decrypting. Tests assuming "the
    // conversation is ready" need both present.
    await authenticatedPage.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    await rawExpect(chatPage.messageList.locator('[data-testid="message-item"]')).toHaveCount(2);

    await use({ id, url: `/chat/${id}` });
  },
});

export { expect, unsettledExpect } from './helpers/settled-expect.js';
