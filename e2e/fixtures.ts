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
    const context = await browser.newContext();
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // Authenticated API request context for cleanup operations
  authenticatedRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: 'http://localhost:8787',
      storageState: 'e2e/.auth/test-alice.json',
    });
    await use(context);
    await context.dispose();
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

    await expect(page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout: 15000 });
    const url = new URL(page.url());
    const id = url.pathname.split('/').pop() ?? '';

    const streamingMessage = page.getByTestId('streaming-message');
    await expect(streamingMessage).toBeVisible({ timeout: 15000 });
    await expect(streamingMessage).not.toBeVisible({ timeout: 15000 });

    await expect(page.getByRole('log', { name: 'Chat messages' }).getByText('Echo:')).toBeVisible({
      timeout: 5000,
    });

    await use({ id, url: page.url() });

    // Cleanup: Delete the conversation after the test completes
    // This prevents test data accumulation and sidebar pollution
    try {
      await authenticatedRequest.delete(`/conversations/${id}`);
    } catch {
      // Ignore cleanup errors - conversation may already be deleted by the test
    }
  },
});

export { expect };
