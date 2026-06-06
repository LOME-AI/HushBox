import { type Page, type Locator } from '@playwright/test';
import {
  normalizeUsername,
  displayUsername,
  isMobileWidth,
  TEST_IDS,
  TEST_ID_BUILDERS,
  type MemberPrivilege,
} from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';

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
    this.facepile = page.getByTestId(TEST_IDS.memberFacepile);
    this.sidebar = page.getByTestId(TEST_IDS.memberSidebar);
    this.content = page.getByTestId(TEST_IDS.memberSidebarContent);
    this.searchInput = page.getByTestId(TEST_IDS.memberSearchInput);
    this.newMemberButton = page.getByTestId(TEST_IDS.newMemberButton);
    this.inviteLinkButton = page.getByTestId(TEST_IDS.inviteLinkButton);
    this.budgetFooter = page.getByTestId(TEST_IDS.memberBudgetTrigger);
  }

  async openViaFacepile(): Promise<void> {
    const isExpanded = await this.searchInput.isVisible().catch(() => false);
    if (!isExpanded) await this.facepile.click();
    await this.waitForLoaded();
    // Mobile mounts the sidebar inside a Radix Sheet. The data-state attribute
    // flips on mount; Playwright's actionability check waits out the slide-in
    // animation before any subsequent interaction. Don't replace this with
    // `getAnimations({ subtree: true })`: the sidebar contains an
    // `animate-pulse` "Decrypting…" placeholder, and `.finished` never resolves
    // for infinite animations — the wait would hang until test timeout.
    const viewport = this.page.viewportSize();
    if (viewport && isMobileWidth(viewport.width)) {
      await expect(this.sidebar).toHaveAttribute('data-state', 'open');
    }
  }

  async waitForLoaded(timeout: number = TIMEOUTS.ASSERT): Promise<void> {
    await this.content.waitFor({ state: 'visible', timeout });
  }

  async expectMemberCount(n: number): Promise<void> {
    // Count text updates after the members query refetches in response to a
    // broadcast-driven invalidation; the React render can lag on mobile
    // viewports. Same reasoning as expectMemberInSection below.
    await expect(this.sidebar.getByText(`MEMBERS (${String(n)})`)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
  }

  section(privilege: MemberPrivilege): Locator {
    return this.page.getByTestId(TEST_ID_BUILDERS.memberSection(privilege));
  }

  async expectSectionVisible(privilege: MemberPrivilege): Promise<void> {
    await expect(this.section(privilege)).toBeVisible();
  }

  async expectSectionNotVisible(privilege: MemberPrivilege): Promise<void> {
    await expect(this.section(privilege)).not.toBeVisible();
  }

  memberRow(memberId: string): Locator {
    return this.page.getByTestId(TEST_ID_BUILDERS.memberItem(memberId));
  }

  async expectMemberInSection(memberId: string, privilege: MemberPrivilege): Promise<void> {
    const sectionLocator = this.section(privilege);
    await expect(sectionLocator.getByTestId(TEST_ID_BUILDERS.memberItem(memberId))).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
  }

  async expectYouBadge(memberId: string): Promise<void> {
    await expect(this.memberRow(memberId).getByTestId(TEST_IDS.memberYouBadge)).toBeVisible();
  }

  async expectOnlineIndicator(entityId: string): Promise<void> {
    // WebSocket presence is an external event from the Durable Object. The
    // budget covers slower mobile-emulation WS connect + presence broadcast.
    await expect(this.page.getByTestId(TEST_ID_BUILDERS.memberOnline(entityId))).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
  }

  linkRow(linkId: string): Locator {
    return this.page.getByTestId(TEST_ID_BUILDERS.linkItem(linkId));
  }

  async expectLinkVisible(linkId: string): Promise<void> {
    await expect(this.linkRow(linkId)).toBeVisible();
  }

  async expectLinkNotVisible(linkId: string): Promise<void> {
    await expect(this.linkRow(linkId)).not.toBeVisible();
  }

  async openMemberActions(memberId: string): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.memberActions(memberId)).click();
  }

  async clickRemoveMember(memberId: string): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.memberRemoveAction(memberId)).click();
  }

  async clickChangePrivilege(memberId: string, newPriv: MemberPrivilege): Promise<void> {
    // Two-step Radix DropdownMenuSub: trigger expands a submenu, then we
    // click an item inside it. Without an explicit visibility wait the
    // second click can fire during the submenu's open animation and miss
    // the onSelect handler (silent failure — no API call).
    await this.page.getByTestId(TEST_ID_BUILDERS.memberChangePrivilege(memberId)).click();
    const option = this.page.getByTestId(TEST_ID_BUILDERS.privilegeOption(memberId, newPriv));
    await expect(option).toBeVisible();
    await option.click();
  }

  async clickLeave(): Promise<void> {
    await this.page.getByTestId(TEST_IDS.memberLeaveAction).click();
  }

  async openLinkActions(linkId: string): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.linkActions(linkId)).click();
  }

  async clickRevokeLinkAction(linkId: string): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.linkRevokeAction(linkId)).click();
  }

  async clickChangeLinkName(linkId: string): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.linkChangeName(linkId)).click();
  }

  async editLinkNameInline(linkId: string, name: string): Promise<void> {
    const input = this.page.getByTestId(TEST_ID_BUILDERS.linkNameInput(linkId));
    await input.fill(name);
    await input.press('Enter');
  }

  async clickChangeLinkPrivilege(linkId: string, priv: MemberPrivilege): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.linkChangePrivilege(linkId)).click();
    const option = this.page.getByTestId(TEST_ID_BUILDERS.linkPrivilegeOption(linkId, priv));
    await expect(option).toBeVisible();
    await option.click();
  }

  async clickNewMember(): Promise<void> {
    await this.newMemberButton.click();
  }

  async clickInviteLink(): Promise<void> {
    await this.inviteLinkButton.click();
  }

  async searchMembers(query: string): Promise<void> {
    await this.searchInput.fill(query);
  }

  async clearSearch(): Promise<void> {
    await this.searchInput.clear();
  }

  async closeSidebar(): Promise<void> {
    await this.sidebar.getByRole('button', { name: 'Close sidebar' }).click();
  }

  /**
   * Closes the member sidebar Sheet on mobile if it's currently open.
   * On desktop this is a no-op — the sidebar doesn't cover the main content.
   */
  async closeMobileSidebarIfOpen(): Promise<void> {
    const viewport = this.page.viewportSize();
    if (viewport === null || !isMobileWidth(viewport.width)) return;

    if (!(await this.content.isVisible().catch(() => false))) return;

    // Wait for any overlapping modal to fully close before dismissing the sheet
    await this.page
      .locator('[data-slot="overlay-content"]')
      .waitFor({ state: 'hidden', timeout: TIMEOUTS.MODAL })
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional swallow
      .catch(() => {});
    await this.page.keyboard.press('Escape');
    await this.content.waitFor({ state: 'hidden', timeout: TIMEOUTS.MODAL });
  }

  async clickBudgetSettings(): Promise<void> {
    await this.budgetFooter.click();
  }

  async getBudgetText(): Promise<string> {
    return (await this.page.getByTestId(TEST_IDS.memberBudgetFooter).textContent()) ?? '';
  }

  /**
   * Find a member row by username text. Useful when you don't know the
   * conversation member ID upfront (it's a UUID generated at group creation).
   */
  findMemberByUsername(username: string): Locator {
    const displayName = displayUsername(normalizeUsername(username));
    return this.content
      .locator(`[data-testid^="${TEST_ID_BUILDERS.memberItem('')}"]`)
      .filter({ hasText: displayName });
  }

  /**
   * Extract the conversation member ID from a member row found by username.
   */
  async getMemberIdByUsername(username: string): Promise<string> {
    const testId = await this.findMemberByUsername(username).getAttribute('data-testid');
    if (!testId) throw new Error(`Member row for "${username}" not found`);
    return testId.replace(TEST_ID_BUILDERS.memberItem(''), '');
  }

  /**
   * Find a link row by its visible display name and return the link ID.
   * Waits for the link to appear in the sidebar (handles re-render delays).
   */
  async getLinkIdByDisplayName(displayName: string): Promise<string> {
    const linkRow = this.content
      .locator(`[data-testid^="${TEST_ID_BUILDERS.linkItem('')}"]`)
      .filter({ hasText: displayName });
    await expect(linkRow).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    const testId = await linkRow.getAttribute('data-testid');
    if (!testId) throw new Error(`Link row for "${displayName}" has no data-testid`);
    return testId.replace(TEST_ID_BUILDERS.linkItem(''), '');
  }
}
