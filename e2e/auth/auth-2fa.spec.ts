import { test, expect } from '../fixtures.js';
import {
  LoginPage,
  SettingsPage,
  TwoFactorSetupModal,
  TwoFactorInputModal,
  DisableTwoFactorModal,
} from '../pages';
import {
  generateTOTPCode,
  signUpAndVerify,
  uniqueEmail,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
  waitForNextTOTPCode,
} from '../helpers/auth.js';
import { DEV_PASSWORD } from '../../packages/shared/src/constants.js';
import { TEST_2FA_TOTP_SECRET } from '../../scripts/seed.js';

test.describe('Two-Factor Authentication', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test.describe('Login with 2FA (seeded user)', () => {
    test.describe.configure({ mode: 'serial' });

    test('invalid 2FA code shows error', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login('test-2fa@test.hushbox.ai', DEV_PASSWORD);

      const tfaModal = new TwoFactorInputModal(unauthenticatedPage);
      await tfaModal.waitForModal();
      await tfaModal.enterCode('000000');
      await tfaModal.verify();
      await tfaModal.expectError(/invalid|failed/i);
    });

    test('valid 2FA code navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login('test-2fa@test.hushbox.ai', DEV_PASSWORD);

      const tfaModal = new TwoFactorInputModal(unauthenticatedPage);
      await tfaModal.waitForModal();
      const code = generateTOTPCode(TEST_2FA_TOTP_SECRET);
      await tfaModal.enterCode(code);
      await tfaModal.verify();

      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: 30_000 });
    });
  });

  test.describe('2FA Setup Lifecycle (fresh user)', () => {
    test('setup → verify → logout → login with 2FA', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(120_000);
      const email = uniqueEmail('e2e-2fa');
      const username = `tfa${String(Date.now()).slice(-6)}`;
      const password = 'TestPassword123!';
      let totpSecret = '';
      let setupCode = '';

      await test.step('setup 2FA: shows QR code and secret', async () => {
        await signUpAndVerify(unauthenticatedPage, request, { username, email, password });

        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.openTwoFactor();

        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.start();

        totpSecret = await setupModal.waitForSecret();
        expect(totpSecret.length).toBeGreaterThan(0);
      });

      await test.step('verify TOTP code enables 2FA', async () => {
        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.continueToVerify();

        setupCode = generateTOTPCode(totpSecret);
        await setupModal.enterCode(setupCode);
        await setupModal.verify();
        await setupModal.expectSuccess();
        await setupModal.done();
      });

      await test.step('logout then login requires 2FA', async () => {
        await logoutViaUI(unauthenticatedPage);

        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.login(email, password);

        const tfaModal = new TwoFactorInputModal(unauthenticatedPage);
        await tfaModal.waitForModal();

        // Wait for a fresh TOTP code to avoid replay protection
        const loginCode = await waitForNextTOTPCode(totpSecret, setupCode);
        await tfaModal.enterCode(loginCode);
        await tfaModal.verify();

        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: 30_000 });
      });
    });
  });

  test.describe('2FA Disable Lifecycle (fresh user)', () => {
    test('enable → disable → login without 2FA', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(120_000);
      const email = uniqueEmail('e2e-2fa-dis');
      const username = `dis${String(Date.now()).slice(-6)}`;
      const password = 'TestPassword123!';
      let totpSecret = '';
      let lastUsedCode = '';

      await test.step('enable 2FA', async () => {
        await signUpAndVerify(unauthenticatedPage, request, { username, email, password });

        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.openTwoFactor();

        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.start();
        totpSecret = await setupModal.waitForSecret();
        await setupModal.continueToVerify();

        lastUsedCode = generateTOTPCode(totpSecret);
        await setupModal.enterCode(lastUsedCode);
        await setupModal.verify();
        await setupModal.expectSuccess();
        await setupModal.done();
      });

      await test.step('disable 2FA via settings', async () => {
        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.expectTwoFactorBadge('Enabled');
        await settingsPage.openTwoFactor();

        const disableModal = new DisableTwoFactorModal(unauthenticatedPage);
        await disableModal.fillPasswordAndContinue(password);

        // Wait for a fresh TOTP code to avoid replay protection
        const disableCode = await waitForNextTOTPCode(totpSecret, lastUsedCode);
        lastUsedCode = disableCode;
        await disableModal.enterCodeAndDisable(disableCode);

        // Modal should close on success
        await expect(disableModal.modal).not.toBeVisible({ timeout: 15_000 });
      });

      await test.step('settings shows 2FA disabled', async () => {
        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.expectTwoFactorBadge('Disabled');
      });

      await test.step('login without 2FA after disable', async () => {
        await logoutViaUI(unauthenticatedPage);

        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.loginAndWaitForChat(email, password);
        await expect(unauthenticatedPage).toHaveURL('/chat');
      });
    });
  });
});
