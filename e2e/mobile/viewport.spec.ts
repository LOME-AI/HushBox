import { TEST_IDS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage } from '../pages';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'mobile' });

test.describe('Mobile viewport height', SPEC_MATRIX, () => {
  test.use({
    viewport: { width: 390, height: 844 }, // iPhone 14
  });

  test('chat input and container adapt to viewport changes', async ({ authenticatedPage }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();

    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    const chatWelcome = authenticatedPage.getByTestId(TEST_IDS.chatWelcome);
    const initialHeight = await chatWelcome.evaluate((el) => (el as HTMLElement).style.height);
    expect(initialHeight).toBe('844px');

    await authenticatedPage.setViewportSize({ width: 390, height: 450 });

    await expect(chatPage.promptInput).toBeVisible();
    await expect(chatPage.promptInput).toBeInViewport();

    await authenticatedPage.waitForFunction(
      ({ selector, expectedHeight }: { selector: string; expectedHeight: string }) => {
        const el = document.querySelector<HTMLElement>(selector);
        return el?.style.height === expectedHeight;
      },
      { selector: `[data-testid="${TEST_IDS.chatWelcome}"]`, expectedHeight: '450px' },
      { timeout: TIMEOUTS.SCROLL_STABLE }
    );

    const shrunkHeight = await chatWelcome.evaluate((el) => (el as HTMLElement).style.height);
    expect(shrunkHeight).toBe('450px');
  });
});
