import { type Page, type Locator, expect } from '@playwright/test';

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

  // --- Locators ---

  /** All document cards in the message list */
  documentCards(): Locator {
    return this.page.getByTestId('document-card');
  }

  /** Nth document card (0-indexed) */
  documentCard(index: number): Locator {
    return this.documentCards().nth(index);
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

  // --- Actions ---

  async clickCard(index: number): Promise<void> {
    await this.documentCard(index).click();
  }

  async closePanel(): Promise<void> {
    await this.closeButton.click();
  }

  // --- Waits ---

  async waitForCardAppear(timeout = 15_000): Promise<void> {
    await this.documentCards().first().waitFor({ state: 'visible', timeout });
  }

  async waitForPanelOpen(timeout = 5000): Promise<void> {
    await this.panel.waitFor({ state: 'visible', timeout });
  }

  async waitForMermaidRendered(timeout = 15_000): Promise<void> {
    await this.mermaidDiagram.waitFor({ state: 'visible', timeout });
  }

  // --- Assertions ---

  async expectTitle(text: string): Promise<void> {
    await expect(this.panelTitle()).toContainText(text);
  }

  async getCardCount(): Promise<number> {
    return this.documentCards().count();
  }

  async getPanelWidth(): Promise<number> {
    const box = await this.panel.boundingBox();
    return box?.width ?? 0;
  }
}
