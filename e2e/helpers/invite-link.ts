import { type Page, expect } from '@playwright/test';
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
  const { privilege = 'read', withHistory = false, closeMethod = 'overlay-close' } = options;

  await sidebar.clickInviteLink();
  const modal = page.getByTestId('invite-link-modal');
  await expect(modal).toBeVisible();

  if (privilege !== 'read') {
    await page.getByTestId('invite-link-privilege-select').selectOption(privilege);
  }

  const historyCheckbox = page.getByTestId('invite-link-history-checkbox').getByRole('checkbox');

  if (withHistory) {
    await historyCheckbox.check();
  } else {
    await expect(historyCheckbox).not.toBeChecked();
  }

  await page.getByTestId('invite-link-generate-button').click();

  const urlEl = page.getByTestId('invite-link-url');
  await expect(urlEl).toBeVisible();
  const url = (await urlEl.textContent()) ?? '';

  if (closeMethod === 'escape') {
    await page.keyboard.press('Escape');
  } else {
    await page.locator('[data-slot="modal-overlay-close"]').click();
  }

  // Capture linkId from sidebar
  const linkRow = sidebar.content.locator('[data-testid^="link-item-"]').first();
  await expect(linkRow).toBeVisible({ timeout: 10_000 });
  const testId = await linkRow.getAttribute('data-testid');
  if (!testId) throw new Error('Expected link row to have data-testid attribute');
  const linkId = testId.replace('link-item-', '');

  return { url, linkId };
}

/**
 * Creates a write-privileged invite link and sets up conversation + member budgets.
 * Combines createInviteLink + budget setup that's repeated across multiple test files.
 */
export async function createWriteLinkWithBudget(
  page: Page,
  sidebar: MemberSidebarPage,
  helper: BudgetHelper,
  conversationId: string,
  options: {
    withHistory?: boolean;
    closeMethod?: 'escape' | 'overlay-close';
    convBudget?: number;
    memberBudget?: number;
  } = {}
): Promise<InviteLinkResult> {
  const { withHistory = false, closeMethod = 'overlay-close', convBudget = 1000, memberBudget = 500 } = options;

  const result = await createInviteLink(page, sidebar, {
    privilege: 'write',
    withHistory,
    closeMethod,
  });

  await helper.setConversationBudget(conversationId, convBudget);
  const linkMemberId = await helper.findLinkMemberId(conversationId, result.linkId);
  await helper.setMemberBudget(conversationId, linkMemberId, memberBudget);

  return result;
}
