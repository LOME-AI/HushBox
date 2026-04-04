import type { Page } from '@playwright/test';
import { expect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';

/**
 * Navigate as a removed member and verify they are redirected away.
 */
export async function expectAccessRevoked(page: Page, conversationId: string): Promise<void> {
  const chatPage = new ChatPage(page);
  await chatPage.gotoConversation(conversationId);

  // Member should be redirected away or see an error
  await expect(page).not.toHaveURL(new RegExp(conversationId), {
    timeout: 10_000,
  });
}
