import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import {
  LoginPage,
  SettingsPage,
  TwoFactorSetupModal,
  TwoFactorLoginStep,
  DisableTwoFactorModal,
} from '../pages';
import {
  generateTOTPCode,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
  getAcceptableTOTPCode,
} from '../helpers/auth.js';
import { DEV_PASSWORD } from '../../packages/shared/src/constants.js';
import { TEST_2FA_TOTP_SECRET } from '../../scripts/seed.js';
import { personaEmail } from '../helpers/personas.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

test.describe('Two-Factor Authentication', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    // The seeded 2FA persona is the one account here that outlives its test:
    // the invalid-code cases spend its TOTP lockout, and nothing else clears it
    // within the window.
    await clearAuthRateLimits(request, [personaEmail('test-2fa')]);
  });

  test.describe('Login with 2FA (seeded user)', () => {
    test('invalid 2FA code shows error', async ({ unauthenticatedPage }) => {
      // Deliberate: this test submits `000000` and asserts the 400 response.
      expectApiErrors(unauthenticatedPage, [
        /400 Bad Request POST .*\/auth\/login\/2fa\/verify/,
        /"code":"INVALID_TOTP_CODE"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 400/,
      ]);
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-2fa'), DEV_PASSWORD);

      const tfaStep = new TwoFactorLoginStep(unauthenticatedPage);
      await tfaStep.waitForStep();
      await tfaStep.enterCode('000000');
      await tfaStep.verify();
      await tfaStep.expectError(/incorrect or has expired/i);
    });

    test('does not ask again for a code the server accepted', async ({
      unauthenticatedPage,
      request,
    }) => {
      // Deliberate: the account read is fabricated as a failure, which is the
      // only way to reach the state where the code was accepted and the rest of
      // the sign-in did not finish. 403 rather than a 5xx so the app-wide query
      // retry adds no jittered backoff.
      expectApiErrors(unauthenticatedPage, [
        /403 Forbidden GET .*\/auth\/me/,
        /"code":"FORBIDDEN"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 403/,
      ]);
      await unauthenticatedPage.route('**/auth/me', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'FORBIDDEN' }),
        })
      );

      // The code prompt is what spends a server-side two-factor attempt, so the
      // verify POST is counted: the state under test must not produce a second.
      let verifyPosts = 0;
      unauthenticatedPage.on('request', (outbound) => {
        if (outbound.method() === 'POST' && outbound.url().includes('/auth/login/2fa/verify')) {
          verifyPosts += 1;
        }
      });

      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-2fa'), DEV_PASSWORD);

      const tfaStep = new TwoFactorLoginStep(unauthenticatedPage);
      await tfaStep.waitForStep();
      const code = await getAcceptableTOTPCode(
        request,
        personaEmail('test-2fa'),
        TEST_2FA_TOTP_SECRET
      );
      await tfaStep.enterCode(code);
      await tfaStep.verify();

      await tfaStep.expectFinishingSignIn();
      await expect(tfaStep.otpInput).toBeHidden();
      expect(verifyPosts).toBe(1);
    });

    test('valid 2FA code navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-2fa'), DEV_PASSWORD);

      const tfaStep = new TwoFactorLoginStep(unauthenticatedPage);
      await tfaStep.waitForStep();
      const code = generateTOTPCode(TEST_2FA_TOTP_SECRET);
      await tfaStep.enterCode(code);
      await tfaStep.verify();

      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    test('Back to login leaves the in-page code step for the login form', async ({
      unauthenticatedPage,
    }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-2fa'), DEV_PASSWORD);

      const tfaStep = new TwoFactorLoginStep(unauthenticatedPage);
      await tfaStep.waitForStep();
      await expect(tfaStep.step).not.toHaveAttribute('role', 'dialog');
      await expect(
        unauthenticatedPage.getByRole('dialog').filter({ has: tfaStep.otpInput })
      ).toHaveCount(0);

      await tfaStep.step.getByRole('button', { name: 'Back to login' }).click();

      await expect(tfaStep.step).toBeHidden();
      await expect(
        unauthenticatedPage.getByRole('heading', { name: 'Welcome back' })
      ).toBeVisible();
      await expect(loginPage.emailInput).toHaveValue(personaEmail('test-2fa'));
      await expect(loginPage.passwordInput).toHaveValue('');
      await expect(loginPage.loginButton).toBeVisible();
    });
  });

  test.describe('2FA Setup Lifecycle (fresh user)', () => {
    test('setup → verify → logout → login with 2FA', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const email = uniqueEmail('e2e-2fa');
      const username = uniqueUsername('tfa');
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
        await loginPage.goto();
        await loginPage.login(email, password);

        const tfaStep = new TwoFactorLoginStep(unauthenticatedPage);
        await tfaStep.waitForStep();

        // Wait for a fresh TOTP code to avoid replay protection
        const loginCode = await getAcceptableTOTPCode(request, email, totpSecret);
        await tfaStep.enterCode(loginCode);
        await tfaStep.verify();

        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
      });
    });
  });

  test.describe('2FA Disable Lifecycle (fresh user)', () => {
    test('enable → disable → login without 2FA', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const email = uniqueEmail('e2e-2fa-dis');
      const username = uniqueUsername('dis');
      const password = 'TestPassword123!';
      let totpSecret = '';

      await test.step('enable 2FA', async () => {
        await signUpAndVerify(unauthenticatedPage, request, { username, email, password });

        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.openTwoFactor();

        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.start();
        totpSecret = await setupModal.waitForSecret();
        await setupModal.continueToVerify();

        const enableCode = generateTOTPCode(totpSecret);
        await setupModal.enterCode(enableCode);
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
        const disableCode = await getAcceptableTOTPCode(request, email, totpSecret);
        await disableModal.enterCodeAndDisable(disableCode);

        await expect(disableModal.modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
      });

      await test.step('settings shows 2FA disabled', async () => {
        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.expectTwoFactorBadge('Disabled');
      });

      await test.step('login without 2FA after disable', async () => {
        await logoutViaUI(unauthenticatedPage);

        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.goto();
        await loginPage.loginAndWaitForChat(email, password);
        await expect(unauthenticatedPage).toHaveURL('/chat');
      });
    });
  });
});
