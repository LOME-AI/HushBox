import { type Page, type Locator } from '@playwright/test';
import { expect, unsettledExpect } from '../helpers/settled-expect.js';
import { requireEnv } from '../helpers/env.js';

const apiUrl = requireEnv('VITE_API_URL');

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
    this.sendButton = page.getByTestId('send-button');
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId('new-chat-page');
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
    this.viewport = page.locator('[data-slot="scroll-area-viewport"]');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat');
  }

  async waitForAppStable(timeout = 15_000): Promise<void> {
    await this.page.locator('[data-app-stable="true"]').waitFor({ state: 'visible', timeout });
  }

  /** Wait for the group chat WebSocket to be connected. Use before actions that send events via WebSocket. */
  async waitForWebSocketConnected(timeout = 15_000): Promise<void> {
    await expect(this.page.locator('[data-ws-connected="true"]')).toBeVisible({ timeout });
  }

  /** Wait for a conversation page to load (message list visible and content rendered). Use instead of waitForAppStable on conversation pages. */
  async waitForConversationLoaded(timeout = 15_000): Promise<void> {
    await this.messageList.waitFor({ state: 'visible', timeout });
    // Wait for Virtuoso to render at least one message OR the "No messages yet"
    // empty state. Without this, getMessageCount() can race ahead of Virtuoso's
    // layout pass. Uses .or() so a single locator resolves for either case.
    await this.messageList
      .locator('[data-testid="message-item"]')
      .first()
      .or(this.messageList.getByText('No messages yet'))
      .waitFor({ state: 'visible', timeout });
  }

  async gotoTrialChat(): Promise<void> {
    await this.page.goto('/chat/trial');
  }

  async gotoConversation(conversationId: string): Promise<void> {
    await this.page.goto(`/chat/${conversationId}`);
  }

  async sendNewChatMessage(message: string): Promise<void> {
    await this.waitForAppStable();
    await this.promptInput.fill(message);
    await expect(this.sendButton).toBeEnabled({ timeout: 15_000 });
    await this.sendButton.click();
  }

  async sendFollowUpMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
    // Wait for streaming to complete (button enabled means canSubmit = true)
    await expect(this.sendButton).toBeEnabled({ timeout: 15_000 });
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async waitForConversation(timeout = 20_000): Promise<string> {
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+(\?.*)?$/, { timeout });
    const url = new URL(this.page.url());
    return url.pathname.split('/').pop() ?? '';
  }

  async expectMessageVisible(message: string, timeout = 10_000): Promise<void> {
    const locator = this.messageList.getByText(message, { exact: true }).first();

    // Fast path: message already in DOM and visible (most callers — recent messages at bottom)
    const alreadyVisible = await locator.isVisible().catch(() => false);
    if (alreadyVisible) return;

    // Slow path: message may be virtualized off-screen. Scroll to top to bring
    // older messages into Virtuoso's render range, then retry.
    await this.scrollToTop();
    await expect(locator).toBeVisible({ timeout });
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

    const target = expectedContent
      ? assistantMessages.getByText(expectedContent, { exact: false }).first()
      : assistantMessages.getByText(/^Echo:/).first();

    await unsettledExpect(target).toBeVisible({ timeout });
  }

  async expectAssistantMessageContains(text: string): Promise<void> {
    await expect(this.messageList.getByText(text).first()).toBeVisible();
  }

  async expectMessageCostVisible(): Promise<void> {
    await expect(this.messageList.locator('[data-testid="message-cost"]').first()).toBeVisible();
  }

  /** Wait for the current stream to fully complete (cost visible = billing + persistence done). */
  async waitForStreamComplete(timeout = 15_000): Promise<void> {
    const costBadge = this.messageList.locator('[data-testid="message-cost"]').last();
    await unsettledExpect(costBadge).toBeVisible({ timeout });
  }

  // --- Group chat locators ---

  getSenderLabels(): Locator {
    return this.messageList.locator('[data-testid="sender-label"]');
  }

  getAiToggleButton(): Locator {
    return this.page.getByRole('button', { name: /AI response/ });
  }

  getTypingIndicator(): Locator {
    return this.page.getByTestId('typing-indicator');
  }

  getMessageGroups(): Locator {
    return this.messageList.locator('[data-testid="message-item"]');
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
    }, pixels);
  }

  async isInputFocused(): Promise<boolean> {
    return this.messageInput.evaluate((el) => el === document.activeElement);
  }

  async selectNonPremiumModel(): Promise<void> {
    await this.selectModels(1);
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

  async scrollToBottom(): Promise<void> {
    await this.viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }

  async getMessageCountViaAPI(): Promise<number> {
    const conversationId = this.getConversationIdFromUrl();
    const url = `${apiUrl}/api/conversations/${conversationId}`;
    const response = await this.page.request.get(url);
    if (!response.ok()) {
      throw new Error(`Failed to get conversation: ${String(response.status())}`);
    }
    const data = (await response.json()) as { messages: unknown[] };
    return data.messages.length;
  }

  // --- Message action buttons ---

  /** Get the nth message item (0-indexed). */
  getMessage(index: number): Locator {
    return this.messageList.locator('[data-testid="message-item"]').nth(index);
  }

  /** Get the last message item. */
  getLastMessage(): Locator {
    return this.messageList.locator('[data-testid="message-item"]').last();
  }

  /** Get message count in the visible list. */
  async getMessageCount(): Promise<number> {
    return this.messageList.locator('[data-testid="message-item"]').count();
  }

  /** Hover over the nth message to reveal action buttons (opacity-0 until hover). */
  async hoverMessage(index: number): Promise<void> {
    await this.getMessage(index).hover();
  }

  /** Hover over the last message. */
  async hoverLastMessage(): Promise<void> {
    await this.getLastMessage().hover();
  }

  /** Get action button on a specific message by aria-label. */
  private getActionButton(messageIndex: number, label: string): Locator {
    return this.getMessage(messageIndex).getByRole('button', { name: label });
  }

  /** Get action button on the last message by aria-label. */
  private getLastMessageActionButton(label: string): Locator {
    return this.getLastMessage().getByRole('button', { name: label });
  }

  getRetryButton(index: number): Locator {
    return this.getActionButton(index, 'Retry');
  }

  getEditButton(index: number): Locator {
    return this.getActionButton(index, 'Edit');
  }

  getRegenerateButton(index: number): Locator {
    return this.getActionButton(index, 'Regenerate');
  }

  getForkButton(index: number): Locator {
    return this.getActionButton(index, 'Fork');
  }

  async clickRetry(index: number): Promise<void> {
    await this.hoverMessage(index);
    await this.getRetryButton(index).click();
  }

  async clickEdit(index: number): Promise<void> {
    await this.hoverMessage(index);
    await this.getEditButton(index).click();
  }

  async clickRegenerate(index: number): Promise<void> {
    await this.hoverMessage(index);
    await this.getRegenerateButton(index).click();
  }

  async clickFork(index: number): Promise<void> {
    await this.hoverMessage(index);
    await this.getForkButton(index).click();
  }

  async clickForkOnLastMessage(): Promise<void> {
    await this.hoverLastMessage();
    await this.getLastMessageActionButton('Fork').click();
  }

  // --- Fork tabs ---

  getForkTabList(): Locator {
    return this.page.getByRole('tablist', { name: 'Conversation forks' });
  }

  getForkTab(name: string): Locator {
    return this.getForkTabList().getByRole('tab', { name });
  }

  async clickForkTab(name: string): Promise<void> {
    await this.getForkTab(name).click();
  }

  async expectForkTabCount(count: number): Promise<void> {
    await expect(this.getForkTabList().getByRole('tab')).toHaveCount(count);
  }

  async expectActiveForkTab(name: string): Promise<void> {
    await expect(this.getForkTab(name)).toHaveAttribute('aria-selected', 'true');
  }

  async expectNoForkTabs(): Promise<void> {
    await expect(this.getForkTabList()).not.toBeVisible();
  }

  /** Open the three-dot menu on a fork tab by name, then click an action. */
  async clickForkTabMenuAction(tabName: string, action: 'Rename' | 'Delete'): Promise<void> {
    const tabWrapper = this.getForkTabList().locator(`[data-testid^="fork-tab-"]`, {
      has: this.page.getByRole('tab', { name: tabName }),
    });
    await tabWrapper.getByRole('button', { name: 'More options' }).click();
    await this.page.getByRole('menuitem', { name: action }).click();
  }

  // --- Edit mode ---

  async expectEditModeActive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).toBeVisible();
  }

  async expectEditModeInactive(): Promise<void> {
    await expect(this.page.getByText('Editing message')).not.toBeVisible();
  }

  async cancelEdit(): Promise<void> {
    await this.page.getByRole('button', { name: 'Cancel' }).click();
  }

  // --- Fork URL helpers ---

  getForkIdFromUrl(): string | null {
    const url = new URL(this.page.url());
    return url.searchParams.get('fork');
  }

  // --- Rename / Delete modals (shared with sidebar) ---

  async confirmRename(newName: string): Promise<void> {
    await expect(this.page.getByText('Rename conversation')).toBeVisible();
    const input = this.page.locator('input[placeholder="Conversation title"]');
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId('save-rename-button').click();
    await expect(this.page.getByText('Rename conversation')).not.toBeVisible();
  }

  async confirmDelete(): Promise<void> {
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId('confirm-delete-button').click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }

  // --- Multi-model selection ---

  /** Open the model selector modal by clicking the header button. */
  async openModelSelector(): Promise<void> {
    await this.page.getByTestId('model-selector-button').click();
    await expect(this.page.getByTestId('model-selector-modal')).toBeVisible();
  }

  /** Toggle a model in the open modal by clicking its checkbox. */
  async toggleModelInModal(modelId: string): Promise<void> {
    const item = this.page.getByTestId(`model-item-${modelId}`);
    await item.getByTestId('model-checkbox').click();
  }

  /** Click the confirm button in the model selector modal footer. */
  async confirmModelSelection(): Promise<void> {
    const modal = this.page.getByTestId('model-selector-modal');
    const selectButton = modal.getByRole('button', { name: /Select\b/ });
    const isSelectVisible = await selectButton.isVisible().catch(() => false);
    if (isSelectVisible) {
      await selectButton.click();
    } else {
      await modal.getByRole('button', { name: 'Close' }).click();
    }
    await unsettledExpect(modal).not.toBeVisible({ timeout: 5000 });
  }

  /**
   * Select N non-premium models via the modal.
   * Opens modal, toggles checkboxes on the first N non-premium models, confirms.
   */
  async selectModels(count: number): Promise<void> {
    await this.openModelSelector();
    const modal = this.page.getByTestId('model-selector-modal');

    // Find all non-premium model items (no lock icon)
    const nonPremiumItems = modal.locator(
      '[data-testid^="model-item-"]:not(:has([data-testid="lock-icon"]))'
    );

    // Clear all selections using the UI button (bypasses the min-1 checkbox guard)
    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) {
      await clearButton.click();
      await this.page.waitForTimeout(100);
    }

    // Select exactly `count` non-premium models
    const available = await nonPremiumItems.count();
    const toSelect = Math.min(count, available);
    for (let index = 0; index < toSelect; index++) {
      const item = nonPremiumItems.nth(index);
      const isSelected = (await item.getAttribute('data-selected')) === 'true';
      if (!isSelected) {
        await item.getByTestId('model-checkbox').click();
        // Wait for React re-render to settle before querying next item
        await this.page.waitForTimeout(100);
      }
    }

    await this.confirmModelSelection();
  }

  /**
   * Select 2 models for partial failure testing:
   * - First non-premium model (will succeed)
   * - LAST non-premium model (will be configured to fail)
   * Returns { successModelId, failModelId }.
   * The fail model is never picked by selectModels(N) since that picks from the front.
   */
  async selectModelsWithFailTarget(): Promise<{ successModelId: string; failModelId: string }> {
    await this.openModelSelector();
    const modal = this.page.getByTestId('model-selector-modal');
    const nonPremiumItems = modal.locator(
      '[data-testid^="model-item-"]:not(:has([data-testid="lock-icon"]))'
    );

    const clearButton = modal.getByTestId('clear-selection-button');
    if (await clearButton.isVisible()) {
      await clearButton.click();
      await this.page.waitForTimeout(100);
    }

    const available = await nonPremiumItems.count();

    // Select first model (success target)
    const firstItem = nonPremiumItems.nth(0);
    await firstItem.getByTestId('model-checkbox').click();
    await this.page.waitForTimeout(100);
    const firstTestId = await firstItem.getAttribute('data-testid');
    const successModelId = (firstTestId ?? '').replace('model-item-', '');

    // Select LAST model (fail target) — never picked by selectModels(N)
    const lastItem = nonPremiumItems.nth(available - 1);
    await lastItem.getByTestId('model-checkbox').click();
    await this.page.waitForTimeout(100);
    const lastTestId = await lastItem.getAttribute('data-testid');
    const failModelId = (lastTestId ?? '').replace('model-item-', '');

    await this.confirmModelSelection();
    return { successModelId, failModelId };
  }

  /** Count selected (checked) models in the open modal. */
  async getSelectedModelCount(): Promise<number> {
    const modal = this.page.getByTestId('model-selector-modal');
    return modal.locator('[data-testid^="model-item-"][data-selected="true"]').count();
  }

  // --- Comparison bar ---

  /** Assert the comparison bar (multi-model pill bar) is visible. */
  async expectComparisonBarVisible(): Promise<void> {
    await expect(this.page.getByTestId('selected-models-bar')).toBeVisible();
  }

  /** Assert the comparison bar is not visible (single model or none). */
  async expectComparisonBarHidden(): Promise<void> {
    await expect(this.page.getByTestId('selected-models-bar')).not.toBeVisible();
  }

  /** Count model pills in the comparison bar. */
  async getComparisonBarModelCount(): Promise<number> {
    const bar = this.page.getByTestId('selected-models-bar');
    return bar.locator('button[aria-label^="Remove "]').count();
  }

  /** Remove a model from the comparison bar by clicking its X button. */
  async removeModelFromBar(modelName: string): Promise<void> {
    await this.page
      .getByTestId('selected-models-bar')
      .getByRole('button', { name: `Remove ${modelName}` })
      .click();
  }

  // --- Model nametag ---

  /** Assert the nametag text on the nth message item (0-indexed). */
  async expectModelNametag(messageIndex: number, expectedName: string): Promise<void> {
    const message = this.getMessage(messageIndex);
    await expect(message.getByTestId('model-nametag')).toContainText(expectedName);
  }

  /** Assert every rendered assistant message has a model nametag.
   *  Only checks DOM-visible items — Virtuoso may virtualise off-screen messages on mobile. */
  async expectAllAIMessagesHaveNametag(): Promise<void> {
    const rendered = this.messageList.locator('[data-role="assistant"]:visible');
    const count = await rendered.count();
    for (let index = 0; index < count; index++) {
      await unsettledExpect(rendered.nth(index).getByTestId('model-nametag')).toBeVisible();
    }
  }

  // --- Multi-model streaming ---

  /**
   * Wait for N AI response messages to appear after sending.
   * Waits for all N to have visible content (not just thinking indicators).
   */
  async waitForMultiModelResponses(count: number, timeout = 15_000): Promise<void> {
    const assistantMessages = this.messageList.locator('[data-role="assistant"]');
    await expect(assistantMessages).toHaveCount(count, { timeout });
    for (let index = 0; index < count; index++) {
      await expect(
        assistantMessages
          .nth(index)
          .getByText(/^Echo:/)
          .first()
      ).toBeVisible({
        timeout,
      });
    }
  }

  /** Get the message content text for an AI response identified by its nametag model name. */
  async getAIResponseByModel(modelName: string): Promise<string> {
    const assistantMessages = this.messageList.locator('[data-role="assistant"]');
    const count = await assistantMessages.count();
    for (let index = 0; index < count; index++) {
      const nametag = assistantMessages.nth(index).getByTestId('model-nametag');
      const nametagText = await nametag.textContent();
      if (nametagText?.includes(modelName)) {
        const messageText = await assistantMessages.nth(index).textContent();
        return messageText ?? '';
      }
    }
    throw new Error(`No AI response found with model nametag "${modelName}"`);
  }

  private getConversationIdFromUrl(): string {
    const url = new URL(this.page.url());
    const id = url.pathname.split('/').pop();
    if (!id || id === 'chat' || id === 'trial') {
      throw new Error('Not on a conversation page');
    }
    return id;
  }
}
