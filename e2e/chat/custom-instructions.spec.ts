import { test, expect, unsettledExpect } from '../fixtures.js';
import { SettingsPage } from '../pages';
import { navigateToSettings } from '../helpers/auth.js';

test.describe('Custom Instructions', () => {
  test('settings page renders all sections, custom instructions lifecycle', async ({
    authenticatedPage,
  }) => {
    await test.step('settings page renders correctly', async () => {
      await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await navigateToSettings(authenticatedPage);
      const settingsPage = new SettingsPage(authenticatedPage);

      await expect(settingsPage.changePasswordButton).toBeVisible();
      await expect(settingsPage.twoFactorButton).toBeVisible();
      await expect(settingsPage.recoveryPhraseButton).toBeVisible();
      await expect(settingsPage.customInstructionsButton).toBeVisible();
      await settingsPage.expectCustomInstructionsBadge('Not set');
    });

    await test.step('modal opens with empty state', async () => {
      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.openCustomInstructions();

      const modal = authenticatedPage.getByTestId('custom-instructions-modal');
      await expect(modal).toBeVisible();

      const textarea = modal.locator('textarea');
      await expect(textarea).toBeVisible();
      await expect(textarea).toHaveValue('');

      await expect(modal.getByText(/0 \/ 5,000/)).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Save' })).toBeVisible();
    });

    await test.step('save custom instructions', async () => {
      const modal = authenticatedPage.getByTestId('custom-instructions-modal');
      const textarea = modal.locator('textarea');

      await textarea.fill('Always respond in bullet points. Never use emojis.');
      await expect(modal.getByText(/50 \/ 5,000/)).toBeVisible();

      await modal.getByRole('button', { name: 'Save' }).click();
      await unsettledExpect(modal).not.toBeVisible({ timeout: 5000 });

      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.expectCustomInstructionsBadge('Active');
    });

    await test.step('reopen modal shows saved instructions', async () => {
      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.openCustomInstructions();

      const modal = authenticatedPage.getByTestId('custom-instructions-modal');
      await expect(modal).toBeVisible();

      const textarea = modal.locator('textarea');
      await expect(textarea).toHaveValue('Always respond in bullet points. Never use emojis.');
    });

    await test.step('clear custom instructions', async () => {
      const modal = authenticatedPage.getByTestId('custom-instructions-modal');
      const textarea = modal.locator('textarea');

      await textarea.clear();
      await expect(modal.getByText(/0 \/ 5,000/)).toBeVisible();

      await modal.getByRole('button', { name: 'Save' }).click();
      await unsettledExpect(modal).not.toBeVisible({ timeout: 5000 });

      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.expectCustomInstructionsBadge('Not set');
    });
  });
});
