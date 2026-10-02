import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { LoginPage, SettingsPage, ChangePasswordModal } from '../pages';
import {
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import {
  expectConversationStillReadable,
  seedConversationCanary,
} from '../helpers/credential-rotation.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

test.describe('Password Change', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request, []);
  });

  test('change password → old fails → new succeeds → conversation still decrypts', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(TIMEOUTS.XXLONG);
    const email = uniqueEmail('e2e-pwd');
    const username = uniqueUsername('pwd');
    const originalPassword = 'TestPassword123!';
    const newPassword = 'NewSecurePassword456!';

    const canary = await test.step('register and write one encrypted turn', async () => {
      await signUpAndVerify(unauthenticatedPage, request, {
        username,
        email,
        password: originalPassword,
      });

      return seedConversationCanary(unauthenticatedPage, `Password canary ${String(Date.now())}`);
    });

    await test.step('change password succeeds', async () => {
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
      await loginPage.goto();
      await loginPage.login(email, originalPassword);
      await loginPage.expectError(/invalid|incorrect|failed/i);
    });

    await test.step('the new password logs in, and the conversation reads back', async () => {
      // A change that re-wraps the account key with the wrong private key still
      // lets the new password log in — the turn written before the change is the
      // only thing that would notice.
      await expectConversationStillReadable(
        unauthenticatedPage,
        { email, password: newPassword },
        canary
      );
    });
  });
});
