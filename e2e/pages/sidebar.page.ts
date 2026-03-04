import { type Page, type Locator, expect } from '@playwright/test';
import { isMobileWidth } from '@hushbox/shared';

export class SidebarPage {
  readonly page: Page;
  readonly hamburgerButton: Locator;
  readonly sidebar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.hamburgerButton = page.getByTestId('hamburger-button');
    this.sidebar = page.getByTestId('sidebar');
  }

  private isMobileViewport(): boolean {
    const viewport = this.page.viewportSize();
    return viewport !== null && isMobileWidth(viewport.width);
  }

  private async openMobileSidebarIfNeeded(): Promise<void> {
    if (!this.isMobileViewport()) return;

    if (await this.sidebar.isVisible()) return;

    await this.hamburgerButton.click();
    await expect(this.sidebar).toBeVisible();
  }

  private async expandSidebarIfCollapsed(): Promise<void> {
    if (this.isMobileViewport()) return;

    const expandButton = this.sidebar.getByRole('button', { name: 'Expand sidebar' });
    if (await expandButton.isVisible()) {
      await expandButton.click();
      await expect(expandButton).not.toBeVisible();
    }
  }

  private async ensureSidebarExpanded(): Promise<void> {
    await this.openMobileSidebarIfNeeded();
    await this.expandSidebarIfCollapsed();
  }

  getChatLink(conversationId: string): Locator {
    return this.sidebar.locator(`a[href="/chat/${conversationId}"]`);
  }

  getChatItemContainer(conversationId: string): Locator {
    return this.getChatLink(conversationId).locator('..');
  }

  async openMoreMenu(conversationId: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const container = this.getChatItemContainer(conversationId).first();
    await container.hover();
    await container.getByTestId('chat-item-more-button').click();
  }

  async renameConversation(conversationId: string, newName: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(this.page.getByText('Rename conversation')).toBeVisible();

    const input = this.page.locator('input[placeholder="Conversation title"]');
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId('save-rename-button').click();

    await expect(this.page.getByText('Rename conversation')).not.toBeVisible();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId('confirm-delete-button').click();
  }

  async cancelDelete(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId('cancel-delete-button').click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }

  async expectConversationVisible(conversationId: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const link = this.getChatLink(conversationId);
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
  }

  async expectConversationTitle(conversationId: string, title: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const link = this.getChatLink(conversationId);
    await link.scrollIntoViewIfNeeded();
    await expect(link.getByText(title)).toBeVisible();
  }

  async countConversationsWithText(text: string): Promise<number> {
    await this.ensureSidebarExpanded();
    const matchingLinks = this.sidebar.locator('a[href^="/chat/"]').filter({ hasText: text });
    return matchingLinks.count();
  }
}
