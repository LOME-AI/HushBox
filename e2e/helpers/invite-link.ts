import type { Page } from '@playwright/test';
import { expect, unsettledExpect } from './settled-expect.js';
import { closeOverlay, expectCorrectOverlayVariant } from './overlay.js';
import type { MemberSidebarPage } from '../pages/member-sidebar.page.js';
import type { BudgetHelper } from './budget.js';

export interface InviteLinkResult {
  url: string;
  linkId: string;
}

export type InviteLinkPrivilege = 'read' | 'write';

export interface CreateInviteLinkOptions {
  privilege?: InviteLinkPrivilege;
  withHistory?: boolean;
  /** How to close the modal after generating: 'escape' or 'overlay-close' (default: 'overlay-close') */
  closeMethod?: 'escape' | 'overlay-close';
  /** Whether to extract linkId from the sidebar after creation (default: true). Set false for read links that don't need budget setup. */
  extractLinkId?: boolean;
  /** Display name for the link. When set, the link is identified by name in the sidebar (deterministic) instead of using `.last()`. */
  displayName?: string;
}

export interface WriteLinkWithBudgetOptions {
  helper: BudgetHelper;
  conversationId: string;
  withHistory?: boolean;
  closeMethod?: 'escape' | 'overlay-close';
  convBudget?: number;
  memberBudget?: number;
  /** Display name for the link. Guarantees budget is set on the correct link by identifying it by name. */
  displayName?: string;
}

async function closeModal(page: Page, method: 'escape' | 'overlay-close'): Promise<void> {
  if (method === 'escape') {
    await page.keyboard.press('Escape');
  } else {
    await closeOverlay(page);
  }
}

async function extractLinkIdFromSidebar(sidebar: MemberSidebarPage): Promise<string> {
  const linkRow = sidebar.content.locator('[data-testid^="link-item-"]').last();
  await expect(linkRow).toBeVisible({ timeout: 10_000 });
  const testId = await linkRow.getAttribute('data-testid');
  if (!testId) throw new Error('Expected link row to have data-testid attribute');
  return testId.replace('link-item-', '');
}

async function fillInviteLinkModal(
  page: Page,
  privilege: InviteLinkPrivilege,
  withHistory: boolean,
  displayName?: string
): Promise<void> {
  if (privilege !== 'read') {
    await page.getByTestId('invite-link-privilege-select').selectOption(privilege);
  }
  if (displayName) {
    await page.getByTestId('invite-link-name-input').fill(displayName);
  }
  const historyCheckbox = page.getByTestId('invite-link-history-checkbox').getByRole('checkbox');
  if (withHistory) {
    await historyCheckbox.check();
  } else {
    await expect(historyCheckbox).not.toBeChecked();
  }
}

/**
 * Creates an invite link via the invite-link modal and extracts the URL + linkId.
 * Assumes the member sidebar is already open and loaded.
 */
export async function createInviteLink(
  page: Page,
  sidebar: MemberSidebarPage,
  options: CreateInviteLinkOptions = {}
): Promise<InviteLinkResult> {
  const {
    privilege = 'read',
    withHistory = false,
    closeMethod = 'overlay-close',
    extractLinkId = true,
    displayName,
  } = options;

  await sidebar.clickInviteLink();
  const modal = page.getByTestId('invite-link-modal');
  await expect(modal).toBeVisible();
  await expectCorrectOverlayVariant(page);

  await fillInviteLinkModal(page, privilege, withHistory, displayName);

  await page.getByTestId('invite-link-generate-button').click();

  const urlEl = page.getByTestId('invite-link-url');
  await unsettledExpect(urlEl).toBeVisible({ timeout: 10_000 });
  const url = (await urlEl.textContent()) ?? '';

  await closeModal(page, closeMethod);

  if (!extractLinkId) {
    return { url, linkId: '' };
  }

  const linkId = displayName
    ? await sidebar.getLinkIdByDisplayName(displayName)
    : await extractLinkIdFromSidebar(sidebar);
  return { url, linkId };
}

/**
 * Creates a write-privileged invite link and sets up conversation + member budgets.
 * Combines createInviteLink + budget setup that's repeated across multiple test files.
 */
export async function createWriteLinkWithBudget(
  page: Page,
  sidebar: MemberSidebarPage,
  options: WriteLinkWithBudgetOptions
): Promise<InviteLinkResult> {
  const {
    helper,
    conversationId,
    withHistory = false,
    closeMethod = 'overlay-close',
    convBudget = 1000,
    memberBudget = 500,
    displayName,
  } = options;

  const result = await createInviteLink(page, sidebar, {
    privilege: 'write',
    withHistory,
    closeMethod,
    ...(displayName !== undefined && { displayName }),
  });

  await helper.setConversationBudget(conversationId, convBudget);
  const linkMemberId = await helper.findLinkMemberId(conversationId, result.linkId);
  await helper.setMemberBudget(conversationId, linkMemberId, memberBudget);

  return result;
}
