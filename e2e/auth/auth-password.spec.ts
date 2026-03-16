import { test, expect } from '../fixtures.js';
import { LoginPage, SettingsPage, ChangePasswordModal } from '../pages';
import {
  signUpAndVerify,
  uniqueEmail,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
} from '../helpers/auth.js';

test.describe('Password Change', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test('change password → old fails → new succeeds', async ({ unauthenticatedPage, request }) => {
    test.setTimeout(120_000);
    const email = uniqueEmail('e2e-pwd');
    const username = `pwd${String(Date.now()).slice(-6)}`;
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

      // Modal closes on success
      await expect(modal.modal).not.toBeVisible({ timeout: 15_000 });
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
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });
  });
});
