import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ChatPage } from '../pages/index.js';
import type { Page } from '@playwright/test';

/**
 * Wait until a shared conversation has actually rendered for the guest, on the
 * readiness signals {@link ChatPage.waitForConversationLoaded} gates.
 *
 * Gating on the loading spinner disappearing instead is equally true of a page
 * that rendered nothing at all, so it proves neither the render nor the
 * decryption the link guest depends on.
 *
 * Opening a guest invite link briefly fires user-auth prefetches
 * (`/billing/balance`, `/conversations?`, and the per-conversation
 * resources still queued for already-logged-in callers like `testBobPage`)
 * before the link-guest context establishes — each 401s with
 * NOT_AUTHENTICATED. Opt out here so every caller doesn't have to repeat
 * the pattern.
 */
export async function expectSharedConversationLoaded(page: Page): Promise<void> {
  expectApiErrors(page, [
    /401 Unauthorized GET .*\/(billing\/balance|conversations\?|(?:budgets|conversations|keys|links|members)\/[0-9a-f-]+)/,
    /"code":"NOT_AUTHENTICATED"/,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: the server responded with a status of 401/]);

  await new ChatPage(page).waitForConversationLoaded();
}

/** Assert no decryption failure text is visible on the page. */
export async function expectNoDecryptionErrors(page: Page): Promise<void> {
  await expect(page.getByText('[decryption failed')).not.toBeVisible();
}

/** Assert the send/message input is visible but disabled (read-only privilege). */
export async function expectSendInputDisabled(
  page: Page,
  inputName: string | RegExp = /message/i
): Promise<void> {
  const sendInput = page.getByRole('textbox', { name: inputName });
  await expect(sendInput).toBeVisible();
  await expect(sendInput).toBeDisabled();
}

/** Assert the read-only notice is visible and no trial/guest errors are shown. */
export async function expectReadOnlyNotice(page: Page): Promise<void> {
  // Budget query paints independently of conversation query.
  await expect(
    page.getByTestId(TEST_ID_BUILDERS.budgetMessage('conversation_read_only'))
  ).toBeVisible({
    timeout: TIMEOUTS.ASSERT,
  });
  await expect(
    page.getByTestId(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays'))
  ).not.toBeVisible();
  await expect(
    page.getByTestId(TEST_ID_BUILDERS.budgetMessage('guest_no_group_budget'))
  ).not.toBeVisible();
}

/** Assert the delegated budget notice is visible and no trial/guest errors are shown. */
export async function expectDelegatedBudgetNotice(page: Page): Promise<void> {
  // Budget notice depends on billing query that loads independently from messages.
  await expect(page.getByTestId(TEST_ID_BUILDERS.budgetMessage('group_budget_pays'))).toBeVisible({
    timeout: TIMEOUTS.ASSERT,
  });
  await expect(
    page.getByTestId(TEST_ID_BUILDERS.budgetMessage('trial_preview_pays'))
  ).not.toBeVisible();
  await expect(
    page.getByTestId(TEST_ID_BUILDERS.budgetMessage('guest_no_group_budget'))
  ).not.toBeVisible();
}

/** Fill message input, click send, and wait for message to appear. */
export async function sendMessageAsGuest(
  page: Page,
  message: string,
  inputName: string | RegExp = 'Ask me anything...'
): Promise<void> {
  const input = page.getByRole('textbox', { name: inputName });
  await expect(input).toBeVisible({ timeout: TIMEOUTS.ASSERT });

  await input.fill(message);

  const sendButton = page.getByTestId(TEST_IDS.sendButton);
  await expect(sendButton).toBeEnabled({ timeout: TIMEOUTS.ASSERT });
  await sendButton.click();

  await expect(page.getByText(message).first()).toBeVisible({ timeout: TIMEOUTS.ASSERT });
}
