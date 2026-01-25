import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

test.describe('Mobile viewport height', () => {
  test.use({
    viewport: { width: 390, height: 844 }, // iPhone 14
  });

  test('chat input and container adapt to viewport changes', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    const chatWelcome = authenticatedPage.getByTestId('chat-welcome');
    const initialHeight = await chatWelcome.evaluate((el) => (el as HTMLElement).style.height);
    expect(initialHeight).toBe('844px');

    await authenticatedPage.setViewportSize({ width: 390, height: 450 });

    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    await authenticatedPage.waitForFunction(
      () => {
        const el = document.querySelector<HTMLElement>('[data-testid="chat-welcome"]');
        return el?.style.height === '450px';
      },
      { timeout: 5000 }
    );

    const shrunkHeight = await chatWelcome.evaluate((el) => (el as HTMLElement).style.height);
    expect(shrunkHeight).toBe('450px');
  });
});
