import { test, expect } from '../fixtures.js';
import { LoginPage, SettingsPage, ChangePasswordModal } from '../pages';
import {
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Password Change', () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
  });

  test('change password → old fails → new succeeds', async ({ unauthenticatedPage, request }) => {
    test.setTimeout(TIMEOUTS.XLONG);
    const email = uniqueEmail('e2e-pwd');
    const username = uniqueUsername('pwd');
    const originalPassword = 'TestPassword123!';
    const newPassword = 'NewSecurePassword456!';

    await test.step('change password succeeds', async () => {
      await signUpAndVerify(unauthenticatedPage, request, {
        username,
        email,
        password: originalPassword,
      });

      await navigateToSettings(unauthenticatedPage);
      const settingsPage = new SettingsPage(unauthenticatedPage);
      await settingsPage.openChangePassword();

      const modal = new ChangePasswordModal(unauthenticatedPage);
      await modal.fillAndSubmit(originalPassword, newPassword);

      await expect(modal.modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
    });

    await test.step('old password fails after change', async () => {
      await logoutViaUI(unauthenticatedPage);

      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(email, originalPassword);
      await loginPage.expectError(/invalid|incorrect|failed/i);
    });

    await test.step('new password succeeds after change', async () => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.loginAndWaitForChat(email, newPassword);
      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });
  });
});
