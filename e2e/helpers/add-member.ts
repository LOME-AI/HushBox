import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Page } from '@playwright/test';
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

  const modal = page.getByTestId(TEST_IDS.addMemberModal);
  await expect(modal).toBeVisible();

  const searchInput = page.getByTestId(TEST_IDS.addMemberSearchInput);
  await searchInput.fill(username);

  const result = page.getByTestId(new RegExp(`^${TEST_ID_BUILDERS.addMemberResult('')}`));
  await expect(result.first()).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  await result.first().click();

  await expect(page.getByTestId(TEST_IDS.addMemberSelected)).toBeVisible();
}
