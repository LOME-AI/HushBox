import { type Page, type Locator } from '@playwright/test';
import { isMobileWidth, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { openMobileSidebarIfNeeded } from '../helpers/auth.js';
import { expect } from '../helpers/expect.js';
import { expectCorrectOverlayVariant } from '../helpers/overlay.js';

export class SidebarPage {
  readonly page: Page;
  readonly sidebar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.getByTestId(TEST_IDS.sidebar);
  }

  private isMobileViewport(): boolean {
    const viewport = this.page.viewportSize();
    return viewport !== null && isMobileWidth(viewport.width);
  }

  /**
   * The {@link openMobileSidebarIfNeeded} imported from `e2e/helpers/auth.ts`
   * is the single implementation of this operation; a copy here would drift
   * from it, and has.
   */
  private async openMobileSidebarIfNeeded(): Promise<void> {
    await openMobileSidebarIfNeeded(this.page);
  }

  private async expandSidebarIfCollapsed(): Promise<void> {
    if (this.isMobileViewport()) return;

    const expandButton = this.sidebar.getByRole('button', { name: 'Expand sidebar' });
    if (await expandButton.isVisible()) {
      await expandButton.click();
      await expect(expandButton).not.toBeVisible();
    }
  }

  /**
   * Bring the sidebar body on screen: the drawer on mobile, the expanded
   * column on desktop (a fresh context lands expanded, but a collapse the test
   * made persists, and the rail draws no conversations). Anything living in
   * the body — conversation rows, the notification offer — is only reachable
   * after this.
   */
  async ensureSidebarExpanded(): Promise<void> {
    await this.openMobileSidebarIfNeeded();
    await this.expandSidebarIfCollapsed();
  }

  getChatLink(conversationId: string): Locator {
    return this.sidebar.locator(`a[href="/chat/${conversationId}"]`);
  }

  getChatItemContainer(conversationId: string): Locator {
    return this.sidebar.getByTestId(TEST_ID_BUILDERS.conversationRow(conversationId));
  }

  async openMoreMenu(conversationId: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const container = this.getChatItemContainer(conversationId);
    await container.hover();
    await container.getByTestId(TEST_IDS.chatItemMoreButton).click();
  }

  /**
   * Chooses a row menu item that opens an overlay, and waits until that overlay is the only one.
   * Below 768px the menu is itself a bottom sheet, which stays on the page while it animates out.
   */
  private async chooseMenuItem(name: string): Promise<void> {
    await this.page.getByRole('menuitem', { name }).click();
    await expect(this.page.getByTestId(TEST_IDS.overlayContent)).toHaveCount(1);
  }

  async renameConversation(conversationId: string, newName: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.chooseMenuItem('Rename');
    await expect(this.page.getByText('Rename conversation', { exact: true })).toBeVisible();
    await expectCorrectOverlayVariant(this.page);

    const input = this.page.getByRole('textbox', { name: 'Conversation title' });
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId(TEST_IDS.saveRenameButton).click();

    await expect(this.page.getByText('Rename conversation', { exact: true })).not.toBeVisible();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.chooseMenuItem('Delete');
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await expectCorrectOverlayVariant(this.page);
    await this.page.getByTestId(TEST_IDS.confirmDeleteButton).click();
  }

  async cancelDelete(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.chooseMenuItem('Delete');
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId(TEST_IDS.cancelDeleteButton).click();
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

  async openInvitesTab(): Promise<void> {
    await this.ensureSidebarExpanded();
    await this.sidebar.getByRole('button', { name: /Invites/ }).click();
  }
}
