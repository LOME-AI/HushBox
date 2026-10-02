import { ChatPage } from '../pages/index.js';
import type { Page } from '@playwright/test';

/**
 * Open the same group conversation on both Alice's and Bob's pages and wait
 * until each side reports that the Durable Object has sent its `{ type:
 * 'ready' }` frame after `handleSession()` + `broadcastPresence()`. Returns
 * the two `ChatPage` instances so callers can drive real-time assertions
 * without re-deriving them.
 */
export async function setupRealtimePair(
  alicePage: Page,
  bobPage: Page,
  conversationId: string
): Promise<{ aliceChatPage: ChatPage; bobChatPage: ChatPage }> {
  const aliceChatPage = new ChatPage(alicePage);
  const bobChatPage = new ChatPage(bobPage);

  await aliceChatPage.gotoConversation(conversationId);
  await bobChatPage.gotoConversation(conversationId);

  await aliceChatPage.waitForConversationLoaded();
  await bobChatPage.waitForConversationLoaded();

  await aliceChatPage.waitForWebSocketConnected();
  await bobChatPage.waitForWebSocketConnected();

  await aliceChatPage.waitForWebSocketReady();
  await bobChatPage.waitForWebSocketReady();

  return { aliceChatPage, bobChatPage };
}
