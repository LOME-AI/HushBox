import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';

interface TestConversation {
  id: string;
  url: string;
}

interface CustomFixtures {
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  testConversation: TestConversation;
  authenticatedRequest: APIRequestContext;
  // Dedicated billing test users (isolated balance state)
  billingSuccessPage: Page;
  billingSuccessPage2: Page;
  billingFailurePage: Page;
  billingValidationPage: Page;
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

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use) => {
    const page = authenticatedPage;
    await page.goto('/chat');

    const testMessage = `Fixture setup ${String(Date.now())}`;
    const input = page.getByRole('textbox', { name: 'Ask me anything...' });
    await input.fill(testMessage);

    const sendButton = page.getByRole('button', { name: 'Send' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // Wait for navigation to conversation page first (happens on successful message send)
    await expect(page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout: 15000 });

    // Then wait for the Echo response to appear
    const echoMessage = page.getByRole('log', { name: 'Chat messages' }).getByText('Echo:');
    await expect(echoMessage).toBeVisible({ timeout: 30000 });

    const url = new URL(page.url());
    const id = url.pathname.split('/').pop() ?? '';

    await use({ id, url: page.url() });

    try {
      await authenticatedRequest.delete(`/conversations/${id}`);
    } catch {
      // Cleanup failures are acceptable - test may have already cleaned up
    }
  },
});

export { expect };
