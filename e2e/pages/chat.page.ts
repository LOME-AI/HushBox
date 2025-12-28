import { type Page, type Locator, expect } from '@playwright/test';

export class ChatPage {
  readonly page: Page;
  readonly promptInput: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly newChatPage: Locator;
  readonly suggestionChips: Locator;
  readonly streamingMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.promptInput = page.getByRole('textbox', { name: 'Ask me anything...' });
    this.messageInput = page.locator('main').getByRole('textbox', { name: /message/i });
    this.sendButton = page.getByRole('button', { name: 'Send' });
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId('new-chat-page');
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
    this.streamingMessage = page.getByTestId('streaming-message');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat');
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
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async waitForConversation(): Promise<string> {
    // Match /chat/{uuid} with optional query params
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/);
    const url = new URL(this.page.url());
    return url.pathname.split('/').pop() ?? '';
  }

  async expectMessageVisible(message: string): Promise<void> {
    await expect(this.messageList.getByText(message, { exact: true })).toBeVisible();
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

  async waitForAIResponse(timeout = 15000): Promise<void> {
    // Wait for streaming to complete - either we catch the indicator or the response is already there
    await Promise.race([
      // Option 1: Streaming indicator appears then disappears
      (async (): Promise<void> => {
        await expect(this.streamingMessage).toBeVisible({ timeout });
        await expect(this.streamingMessage).not.toBeVisible({ timeout });
      })(),
      // Option 2: Response already rendered (streaming was too fast to observe)
      expect(this.messageList.getByText(/^Echo:/).first()).toBeVisible({ timeout }),
    ]);
  }

  async expectAssistantMessageContains(text: string): Promise<void> {
    // Use .first() to handle cases where multiple messages contain the text
    await expect(this.messageList.getByText(text).first()).toBeVisible();
  }
}
