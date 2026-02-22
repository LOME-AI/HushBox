import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';

interface TestConversation {
  id: string;
  url: string;
}

interface GroupConversation {
  id: string;
  members: { userId: string; username: string; email: string }[];
}

interface CustomFixtures {
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  testConversation: TestConversation;
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
  authenticatedPage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-alice.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  unauthenticatedPage: async ({ browser }, use) => {
    // Explicitly clear storage state to override project-level default auth
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  authenticatedRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: 'http://localhost:8787',
      storageState: 'e2e/.auth/test-alice.json',
    });
    await use(context);
    await context.dispose();
  },

  // 2FA test user (has TOTP enabled)
  test2FAPage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-2fa.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // Dedicated billing test users (isolated balance state between tests)
  billingSuccessPage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-billing-success.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  billingSuccessPage2: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-billing-success-2.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  billingFailurePage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-billing-failure.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  billingValidationPage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-billing-validation.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  billingDevModePage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-billing-devmode.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // Group chat: creates conversation with seeded messages via dev endpoint
  groupConversation: async ({ authenticatedRequest }, use) => {
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
          {
            senderEmail: 'test-alice@test.hushbox.ai',
            content: 'Second from Alice',
            senderType: 'user',
          },
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

    expect(response.ok(), `group-chat creation failed: ${String(response.status())}`).toBe(true);
    const data = (await response.json()) as {
      conversationId: string;
      members: GroupConversation['members'];
    };
    await use({ id: data.conversationId, members: data.members });

    try {
      await authenticatedRequest.delete(`/api/conversations/${data.conversationId}`);
    } catch {
      // Cleanup failures are acceptable
    }
  },

  // Second browser context logged in as test-bob
  testBobPage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-bob.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // Browser context logged in as test-dave (verified, no group membership by default)
  testDavePage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/test-dave.json',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // API request context for test-bob (used for owner-privilege budget operations)
  testBobRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: 'http://localhost:8787',
      storageState: 'e2e/.auth/test-bob.json',
    });
    await use(context);
    await context.dispose();
  },

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use) => {
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

    try {
      await authenticatedRequest.delete(`/api/conversations/${id}`);
    } catch {
      // Cleanup failures are acceptable - test may have already cleaned up
    }
  },
});

export { expect } from '@playwright/test';
