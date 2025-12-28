import { test as base, expect, type Page } from '@playwright/test';

interface TestConversation {
  id: string;
  url: string;
}

interface CustomFixtures {
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  testConversation: TestConversation;
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

  testConversation: async ({ authenticatedPage }, use) => {
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
  },
});

export { expect };
