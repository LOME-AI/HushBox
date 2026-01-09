import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

test.describe('Mobile viewport height', () => {
  test.use({
    viewport: { width: 390, height: 844 }, // iPhone 14
  });

  test('chat input stays visible when viewport shrinks (keyboard simulation)', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    // Verify initial state
    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    // Simulate keyboard opening by shrinking viewport
    await authenticatedPage.setViewportSize({ width: 390, height: 450 });

    // Input should still be visible and in viewport
    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();
  });

  test('container height updates with viewport', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    // Check container height matches viewport
    const initialHeight = await chatPage.newChatPage.evaluate(
      (el) => (el as HTMLElement).style.height
    );
    expect(initialHeight).toBe('844px');

    await authenticatedPage.setViewportSize({ width: 390, height: 450 });

    await authenticatedPage.waitForFunction(
      () => {
        const el = document.querySelector<HTMLElement>('[data-testid="new-chat-page"]');
        return el?.style.height === '450px';
      },
      { timeout: 5000 }
    );

    const shrunkHeight = await chatPage.newChatPage.evaluate(
      (el) => (el as HTMLElement).style.height
    );
    expect(shrunkHeight).toBe('450px');
  });
});
