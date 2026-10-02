import { type Locator } from '@playwright/test';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { ChatTranscriptPage } from './chat-transcript.page.js';

/** Every branch row: the builder's id with no fork id is the prefix every row's id shares. */
const BRANCH_ROW_SELECTOR = `[data-testid^="${TEST_ID_BUILDERS.branchRow('')}"]`;

/**
 * The conversation's branches: the switcher that lists them, switching between them by
 * name, their rename and delete actions, and the dialogs those actions open.
 */
export class ChatBranchesPage extends ChatTranscriptPage {
  /** The header control that opens the switcher; drawn while the conversation has branches. */
  getBranchSwitcher(): Locator {
    return this.page.getByTestId(TEST_IDS.branchSwitcher);
  }

  /** The open switcher: anchored under the header from 768, a sheet below. */
  getBranchList(): Locator {
    return this.page.getByTestId(TEST_IDS.branchSwitcherMenu);
  }

  /**
   * The row that switches to the named branch. A branch is listed under every fork point it
   * parts at, so its first row stands for it.
   */
  getBranch(branchName: string): Locator {
    return this.getBranchList().getByRole('button', { name: branchName, exact: true }).first();
  }

  /**
   * Opens the switcher from whatever the page drew: from 768, the header's control. Every
   * method here starts with the switcher closed and leaves it closed.
   */
  async openBranches(): Promise<void> {
    await this.getBranchSwitcher().click();
    await expect(this.getBranchList()).toBeVisible();
  }

  async closeBranches(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(this.getBranchList()).not.toBeVisible();
  }

  async openBranch(branchName: string): Promise<void> {
    await this.openBranches();
    await this.getBranch(branchName).click();
    await expect(this.getBranchList()).not.toBeVisible();
  }

  /** Counts branches, not rows: a branch parting at two fork points has a row under each. */
  async expectBranchCount(count: number): Promise<void> {
    await this.openBranches();
    const rows = this.getBranchList().locator(BRANCH_ROW_SELECTOR);
    await expect
      .poll(
        async () =>
          new Set(await rows.evaluateAll((els) => els.map((el) => el.dataset['testid']))).size
      )
      .toBe(count);
    await this.closeBranches();
  }

  async expectBranchListed(branchName: string): Promise<void> {
    await this.openBranches();
    await expect(this.getBranch(branchName)).toBeVisible();
    await this.closeBranches();
  }

  async expectBranchNotListed(branchName: string): Promise<void> {
    await this.openBranches();
    await expect(this.getBranch(branchName)).toHaveCount(0);
    await this.closeBranches();
  }

  async expectCurrentBranch(branchName: string): Promise<void> {
    await this.openBranches();
    await expect(this.getBranch(branchName)).toHaveAttribute('aria-current', 'true');
    await this.closeBranches();
  }

  async expectNoBranches(): Promise<void> {
    await expect(this.getBranchSwitcher()).toHaveCount(0);
  }

  /** Opens the switcher, then the named branch's Rename or Delete; the switcher closes. */
  async clickBranchMenuAction(branchName: string, action: 'Rename' | 'Delete'): Promise<void> {
    await this.openBranches();
    await this.getBranchList()
      .getByRole('button', { name: `${action} ${branchName}`, exact: true })
      .first()
      .click();
    await expect(this.getBranchList()).not.toBeVisible();
  }

  getForkIdFromUrl(): string | null {
    const url = new URL(this.page.url());
    return url.searchParams.get('fork');
  }

  async confirmRename(newName: string): Promise<void> {
    await expect(this.page.getByText('Rename conversation', { exact: true })).toBeVisible();
    const input = this.page.getByRole('textbox', { name: 'Conversation title' });
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId(TEST_IDS.saveRenameButton).click();
    await expect(this.page.getByText('Rename conversation', { exact: true })).not.toBeVisible();
  }

  async confirmDelete(): Promise<void> {
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId(TEST_IDS.confirmDeleteButton).click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }
}
