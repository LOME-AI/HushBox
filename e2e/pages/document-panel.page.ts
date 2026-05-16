import { type Page, type Locator } from '@playwright/test';
import { expect } from '../helpers/settled-expect.js';
import type { ChatPage } from './chat.page.js';

export class DocumentPanelPage {
  readonly page: Page;
  readonly panel: Locator;
  readonly scrollArea: Locator;
  readonly resizeHandle: Locator;
  readonly highlightedCode: Locator;
  readonly closeButton: Locator;
  readonly downloadButton: Locator;
  readonly mermaidDiagram: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId('document-panel');
    this.scrollArea = page.getByTestId('document-panel-scroll');
    this.resizeHandle = page.getByTestId('resize-handle');
    this.highlightedCode = page.getByTestId('highlighted-code');
    this.closeButton = page.getByRole('button', { name: 'Close panel' });
    this.downloadButton = page.getByRole('button', { name: 'Download file' });
    this.mermaidDiagram = page.getByTestId('mermaid-diagram');
  }

  /** The currently active (selected) document card */
  activeCard(): Locator {
    return this.page.locator('[data-testid="document-card"][data-active="true"]');
  }

  /** Copy button (changes aria-label to "Copied" after click) */
  copyButton(): Locator {
    return this.panel.getByRole('button', { name: 'Copy code' });
  }

  /** Copy button in "Copied" feedback state */
  copiedButton(): Locator {
    return this.panel.getByRole('button', { name: 'Copied' });
  }

  /** Fullscreen button (toggles between "Fullscreen" and "Exit fullscreen") */
  fullscreenButton(): Locator {
    return this.panel.getByRole('button', { name: 'Fullscreen' });
  }

  exitFullscreenButton(): Locator {
    return this.panel.getByRole('button', { name: 'Exit fullscreen' });
  }

  /** Raw/rendered toggle (mermaid only) */
  showRawButton(): Locator {
    return this.panel.getByRole('button', { name: 'Show raw' });
  }

  showRenderedButton(): Locator {
    return this.panel.getByRole('button', { name: 'Show rendered' });
  }

  /** Panel title heading */
  panelTitle(): Locator {
    return this.panel.locator('h2');
  }

  async closePanel(): Promise<void> {
    await this.closeButton.click();
  }

  /**
   * Return the document card belonging to the message at `messageIndex`.
   * Addressing by message index (rather than nth-among-all-cards) is robust
   * to Virtuoso virtualization: on small viewports only one document-card
   * row is mounted at a time, so `.nth(N)` will silently fail. The caller
   * is expected to know which message holds the card it wants.
   */
  cardInMessage(chatPage: ChatPage, messageIndex: number): Locator {
    return chatPage.getMessage(messageIndex).getByTestId('document-card').first();
  }

  /**
   * Park the row at `messageIndex` in Virtuoso's mounted window, then assert
   * its document card is visible. Returns the card locator for the caller.
   */
  async scrollToCardInMessage(
    chatPage: ChatPage,
    messageIndex: number,
    timeout = 15_000
  ): Promise<Locator> {
    await chatPage.scrollMessageIntoView(messageIndex);
    const card = this.cardInMessage(chatPage, messageIndex);
    await expect(card).toBeVisible({ timeout });
    return card;
  }

  /**
   * Click the card belonging to the message at `messageIndex` after parking
   * its row in Virtuoso's mounted window.
   */
  async clickCardInMessage(chatPage: ChatPage, messageIndex: number): Promise<void> {
    const card = await this.scrollToCardInMessage(chatPage, messageIndex);
    await card.click();
  }

  async waitForPanelOpen(timeout = 5000): Promise<void> {
    await this.panel.waitFor({ state: 'visible', timeout });
  }

  async waitForMermaidRendered(timeout = 15_000): Promise<void> {
    await this.mermaidDiagram.waitFor({ state: 'visible', timeout });
  }

  async expectTitle(text: string): Promise<void> {
    await expect(this.panelTitle()).toContainText(text);
  }

  async getPanelWidth(): Promise<number> {
    const box = await this.panel.boundingBox();
    return box?.width ?? 0;
  }
}
