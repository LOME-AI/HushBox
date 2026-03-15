import { type Page, expect } from '@playwright/test';

/** Wait for the shared conversation loading spinner to disappear. */
export async function expectSharedConversationLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('shared-conversation-loading')).not.toBeVisible({
    timeout: 15_000,
  });
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

/** Assert the read-only notice is visible and trial notice is not. */
export async function expectReadOnlyNotice(page: Page): Promise<void> {
  await expect(page.getByTestId('budget-message-read_only_notice')).toBeVisible();
  await expect(page.getByTestId('budget-message-trial_notice')).not.toBeVisible();
}

/** Assert the delegated budget notice is visible and trial notice is not. */
export async function expectDelegatedBudgetNotice(page: Page): Promise<void> {
  await expect(page.getByTestId('budget-message-delegated_budget_notice')).toBeVisible();
  await expect(page.getByTestId('budget-message-trial_notice')).not.toBeVisible();
}

/** Fill message input, click send, and wait for message to appear. */
export async function sendMessageAsGuest(
  page: Page,
  message: string,
  inputName: string | RegExp = 'Ask me anything...'
): Promise<void> {
  const input = page.getByRole('textbox', { name: inputName });
  await expect(input).toBeVisible({ timeout: 5000 });

  await input.fill(message);

  const sendButton = page.getByTestId('send-button');
  await expect(sendButton).toBeEnabled({ timeout: 5000 });
  await sendButton.click();

  await expect(page.getByText(message).first()).toBeVisible({ timeout: 10_000 });
}
