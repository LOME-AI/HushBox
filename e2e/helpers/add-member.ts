import { type Page, expect } from '@playwright/test';
import type { MemberSidebarPage } from '../pages/member-sidebar.page.js';

/**
 * Searches for and selects a user in the add-member modal.
 * Assumes the member sidebar is already open and loaded.
 * Does NOT submit the modal — caller should set privilege/history options and submit.
 */
export async function searchAndSelectMember(
  page: Page,
  sidebar: MemberSidebarPage,
  username: string
): Promise<void> {
  await sidebar.clickNewMember();

  const modal = page.getByTestId('add-member-modal');
  await expect(modal).toBeVisible();

  const searchInput = page.getByTestId('add-member-search-input');
  await searchInput.fill(username);

  const result = page.getByTestId(/^add-member-result-/);
  await expect(result.first()).toBeVisible({ timeout: 5000 });
  await result.first().click();

  await expect(page.getByTestId('add-member-selected')).toBeVisible();
}
