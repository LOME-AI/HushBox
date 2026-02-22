import { type Page, type Locator, expect } from '@playwright/test';
import { normalizeUsername, displayUsername } from '@hushbox/shared';

export class MemberSidebarPage {
  readonly page: Page;
  readonly facepile: Locator;
  readonly sidebar: Locator;
  readonly content: Locator;
  readonly searchInput: Locator;
  readonly newMemberButton: Locator;
  readonly inviteLinkButton: Locator;
  readonly budgetFooter: Locator;

  constructor(page: Page) {
    this.page = page;
    this.facepile = page.getByTestId('member-facepile');
    this.sidebar = page.getByTestId('member-sidebar');
    this.content = page.getByTestId('member-sidebar-content');
    this.searchInput = page.getByTestId('member-search-input');
    this.newMemberButton = page.getByTestId('new-member-button');
    this.inviteLinkButton = page.getByTestId('invite-link-button');
    this.budgetFooter = page.getByTestId('member-budget-trigger');
  }

  // --- Navigation ---

  async openViaFacepile(): Promise<void> {
    await this.facepile.click();
  }

  async waitForLoaded(timeout = 10_000): Promise<void> {
    await this.content.waitFor({ state: 'visible', timeout });
  }

  // --- Assertions ---

  async expectMemberCount(n: number): Promise<void> {
    await expect(this.sidebar.getByText(`MEMBERS (${String(n)})`)).toBeVisible();
  }

  section(privilege: string): Locator {
    return this.page.getByTestId(`member-section-${privilege}`);
  }

  async expectSectionVisible(privilege: string): Promise<void> {
    await expect(this.section(privilege)).toBeVisible();
  }

  async expectSectionNotVisible(privilege: string): Promise<void> {
    await expect(this.section(privilege)).not.toBeVisible();
  }

  memberRow(memberId: string): Locator {
    return this.page.getByTestId(`member-item-${memberId}`);
  }

  async expectMemberInSection(memberId: string, privilege: string): Promise<void> {
    const sectionLocator = this.section(privilege);
    await expect(sectionLocator.getByTestId(`member-item-${memberId}`)).toBeVisible();
  }

  async expectYouBadge(memberId: string): Promise<void> {
    await expect(this.memberRow(memberId).getByTestId('member-you-badge')).toBeVisible();
  }

  async expectOnlineIndicator(entityId: string): Promise<void> {
    await expect(this.page.getByTestId(`member-online-${entityId}`)).toBeVisible();
  }

  linkRow(linkId: string): Locator {
    return this.page.getByTestId(`link-item-${linkId}`);
  }

  async expectLinkVisible(linkId: string): Promise<void> {
    await expect(this.linkRow(linkId)).toBeVisible();
  }

  async expectLinkNotVisible(linkId: string): Promise<void> {
    await expect(this.linkRow(linkId)).not.toBeVisible();
  }

  // --- Member actions ---

  async openMemberActions(memberId: string): Promise<void> {
    await this.page.getByTestId(`member-actions-${memberId}`).click();
  }

  async clickRemoveMember(memberId: string): Promise<void> {
    await this.page.getByTestId(`member-remove-action-${memberId}`).click();
  }

  async clickChangePrivilege(memberId: string, newPriv: string): Promise<void> {
    await this.page.getByTestId(`member-change-privilege-${memberId}`).click();
    await this.page.getByTestId(`privilege-option-${memberId}-${newPriv}`).click();
  }

  async clickLeave(): Promise<void> {
    await this.page.getByTestId('member-leave-action').click();
  }

  // --- Link actions ---

  async openLinkActions(linkId: string): Promise<void> {
    await this.page.getByTestId(`link-actions-${linkId}`).click();
  }

  async clickRevokeLinkAction(linkId: string): Promise<void> {
    await this.page.getByTestId(`link-revoke-action-${linkId}`).click();
  }

  async clickChangeLinkName(linkId: string): Promise<void> {
    await this.page.getByTestId(`link-change-name-${linkId}`).click();
  }

  async editLinkNameInline(linkId: string, name: string): Promise<void> {
    const input = this.page.getByTestId(`link-name-input-${linkId}`);
    await input.fill(name);
    await input.press('Enter');
  }

  async clickChangeLinkPrivilege(linkId: string, priv: string): Promise<void> {
    await this.page.getByTestId(`link-change-privilege-${linkId}`).click();
    await this.page.getByTestId(`link-privilege-option-${linkId}-${priv}`).click();
  }

  // --- Admin buttons ---

  async clickNewMember(): Promise<void> {
    await this.newMemberButton.click();
  }

  async clickInviteLink(): Promise<void> {
    await this.inviteLinkButton.click();
  }

  // --- Search ---

  async searchMembers(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }

  async clearSearch(): Promise<void> {
    await this.searchInput.clear();
  }

  // --- Close ---

  async closeSidebar(): Promise<void> {
    await this.sidebar.getByRole('button', { name: 'Close sidebar' }).click();
  }

  // --- Budget ---

  async clickBudgetSettings(): Promise<void> {
    await this.budgetFooter.click();
  }

  async getBudgetText(): Promise<string> {
    return (await this.page.getByTestId('member-budget-footer').textContent()) ?? '';
  }

  // --- Username-based helpers ---

  /**
   * Find a member row by username text. Useful when you don't know the
   * conversation member ID upfront (it's a UUID generated at group creation).
   */
  findMemberByUsername(username: string): Locator {
    const displayName = displayUsername(normalizeUsername(username));
    return this.content.locator('[data-testid^="member-item-"]').filter({ hasText: displayName });
  }

  /**
   * Extract the conversation member ID from a member row found by username.
   */
  async getMemberIdByUsername(username: string): Promise<string> {
    const testId = await this.findMemberByUsername(username).getAttribute('data-testid');
    if (!testId) throw new Error(`Member row for "${username}" not found`);
    return testId.replace('member-item-', '');
  }
}
