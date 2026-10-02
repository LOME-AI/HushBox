import { type Locator } from '@playwright/test';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ChatBranchesPage } from './chat-branches.page.js';

/**
 * The chat page. Its own section is loading a conversation and the group-chat
 * locators; the branches, the transcript, the composer and the shell it extends
 * carry the rest.
 */
export class ChatPage extends ChatBranchesPage {
  /**
   * Wait for a conversation page to load. Use instead of waitForAppStable on
   * conversation pages. Waits for the message list to mount, for either a
   * message-item or the empty state to render, and for every message to
   * finish decrypting (so a follow-up assertion can scroll to any message
   * without racing the decrypt result).
   */
  async waitForConversationLoaded(timeout: number = TIMEOUTS.CONVERSATION_LOAD): Promise<void> {
    await this.messageList.waitFor({ state: 'visible', timeout });
    await this.messageList
      .getByTestId(TEST_IDS.messageItem)
      .first()
      .or(this.messageList.getByText('No messages yet'))
      .waitFor({ state: 'visible', timeout });
    await this.waitForDecryptionComplete(timeout);
  }

  /**
   * Wait until every message in the conversation has been decrypted, using
   * the `data-decrypted-count` attribute exposed by `MessageList`. Resolves
   * immediately when the conversation is empty.
   */
  async waitForDecryptionComplete(timeout: number = TIMEOUTS.CONVERSATION_LOAD): Promise<void> {
    await this.page.waitForFunction(
      (selectors: { list: string; empty: string; count: string; decrypted: string }) => {
        const list = document.querySelector<HTMLElement>(`${selectors.list}, ${selectors.empty}`);
        if (!list) return false;
        const messageCount = Number(list.getAttribute(selectors.count));
        const decryptedCount = Number(list.getAttribute(selectors.decrypted));
        if (Number.isNaN(messageCount) || Number.isNaN(decryptedCount)) return false;
        return decryptedCount >= messageCount;
      },
      {
        list: `[data-testid="${TEST_IDS.messageList}"]`,
        empty: `[data-testid="${TEST_IDS.messageListEmpty}"]`,
        count: TEST_SIGNALS.messageCount,
        decrypted: TEST_SIGNALS.decryptedCount,
      },
      { timeout }
    );
  }

  async waitForConversation(timeout: number = TIMEOUTS.ROUTE): Promise<string> {
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout });
    const url = new URL(this.page.url());
    return url.pathname.split('/').pop() ?? '';
  }

  getSenderLabels(): Locator {
    return this.messageList.getByTestId(TEST_IDS.senderLabel);
  }

  getAiToggleButton(): Locator {
    return this.page.getByRole('button', { name: 'AI replies to this message' });
  }

  getTypingIndicator(): Locator {
    return this.page.getByTestId(TEST_IDS.typingIndicator);
  }

  getMessageGroups(): Locator {
    return this.messageList.getByTestId(TEST_IDS.messageItem);
  }
}
