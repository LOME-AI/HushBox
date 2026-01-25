import { type Page, type Locator, expect } from '@playwright/test';

export class ChatPage {
  readonly page: Page;
  readonly promptInput: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly newChatPage: Locator;
  readonly suggestionChips: Locator;
  readonly viewport: Locator;

  constructor(page: Page) {
    this.page = page;
    this.promptInput = page.getByRole('textbox', { name: 'Ask me anything...' });
    this.messageInput = page.locator('main').getByRole('textbox', { name: /message/i });
    this.sendButton = page.getByRole('button', { name: 'Send' });
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId('new-chat-page');
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
    this.viewport = page.locator('[data-slot="scroll-area-viewport"]');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat');
  }

  async gotoGuestChat(): Promise<void> {
    await this.page.goto('/chat/guest');
  }

  async gotoConversation(conversationId: string): Promise<void> {
    await this.page.goto(`/chat/${conversationId}`);
  }

  async sendNewChatMessage(message: string): Promise<void> {
    await this.promptInput.fill(message);
    await expect(this.sendButton).toBeEnabled();
    await this.sendButton.click();
  }

  async sendFollowUpMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
    // Wait for streaming to complete (button enabled means canSubmit = true)
    await expect(this.sendButton).toBeEnabled();
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async waitForConversation(timeout = 10_000): Promise<string> {
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout });
    const url = new URL(this.page.url());
    return url.pathname.split('/').pop() ?? '';
  }

  async expectMessageVisible(message: string): Promise<void> {
    await expect(this.messageList.getByText(message, { exact: true }).first()).toBeVisible();
  }

  async expectNewChatPageVisible(): Promise<void> {
    await expect(this.newChatPage).toBeVisible();
  }

  async expectPromptInputVisible(): Promise<void> {
    await expect(this.promptInput).toBeVisible();
  }

  async expectSuggestionChipsVisible(): Promise<void> {
    await expect(this.suggestionChips).toBeVisible();
  }

  async waitForAIResponse(expectedContent?: string, timeout = 10_000): Promise<void> {
    const assistantMessages = this.messageList.locator('[data-role="assistant"]');

    if (expectedContent) {
      // Markdown splits "Echo:\n\n${content}" into separate <p> elements
      await expect(
        assistantMessages.getByText(expectedContent, { exact: false }).first()
      ).toBeVisible({
        timeout,
      });
    } else {
      await expect(assistantMessages.getByText(/^Echo:/).first()).toBeVisible({ timeout });
    }
  }

  async expectAssistantMessageContains(text: string): Promise<void> {
    await expect(this.messageList.getByText(text).first()).toBeVisible();
  }

  async getScrollPosition(): Promise<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }> {
    return this.viewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  }

  async scrollToTop(): Promise<void> {
    await this.viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
  }

  async scrollUp(pixels: number): Promise<void> {
    await this.viewport.evaluate((el, px) => {
      el.scrollTop = Math.max(0, el.scrollTop - px);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, pixels);
  }

  async isInputFocused(): Promise<boolean> {
    return this.messageInput.evaluate((el) => el === document.activeElement);
  }

  async selectNonPremiumModel(): Promise<void> {
    const modelSelector = this.page.getByTestId('model-selector-button');
    await modelSelector.click();

    const modal = this.page.getByTestId('model-selector-modal');
    await expect(modal).toBeVisible();

    const nonPremiumModel = modal
      .locator('[data-testid^="model-item-"]:not(:has([data-testid="lock-icon"]))')
      .first();
    await nonPremiumModel.dblclick();

    await expect(modal).not.toBeVisible();
  }

  async findOverflowingElements(): Promise<string[]> {
    return this.page.evaluate(() => {
      const skipPattern = /sr-only|truncate|overflow-hidden/;
      return [...document.querySelectorAll('*')]
        .map((element) => {
          const el = element as HTMLElement;
          const overflow = el.scrollWidth - el.clientWidth;
          return { el, overflow };
        })
        .filter(({ el, overflow }) => overflow > 100 && el.clientWidth > 0)
        .filter(({ el }) => !skipPattern.test(el.className))
        .map(({ el, overflow }) => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className ? `.${el.className.replaceAll(/\s+/g, '.')}` : '';
          const testId = el.dataset['testid'] ? `[data-testid="${el.dataset['testid']}"]` : '';
          const slot = el.dataset['slot'] ? `[data-slot="${el.dataset['slot']}"]` : '';
          return `${tag}${id}${testId}${slot} overflow:${String(overflow)} scrollW:${String(el.scrollWidth)} clientW:${String(el.clientWidth)}\n  classes: ${cls.slice(0, 200)}`;
        });
    });
  }

  async getViewportWidth(): Promise<number> {
    return this.page.evaluate(() => window.innerWidth);
  }

  async getDocumentDimensions(): Promise<{ scrollWidth: number; clientWidth: number }> {
    return this.page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
  }

  async getLastUserMessagePosition(): Promise<{
    top: number;
    viewportTop: number;
    viewportHeight: number;
  }> {
    const lastUserMessage = this.messageList.locator('[data-role="user"]').last();
    const messageRect = await lastUserMessage.boundingBox();
    const viewportRect = await this.viewport.boundingBox();

    if (!messageRect || !viewportRect) {
      throw new Error('Could not get bounding boxes');
    }

    return {
      top: messageRect.y - viewportRect.y,
      viewportTop: viewportRect.y,
      viewportHeight: viewportRect.height,
    };
  }

  async scrollToBottom(): Promise<void> {
    await this.viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }
}
