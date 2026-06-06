import { test, expect } from '../fixtures.js';
import {
  SettingsPage,
  RecoveryPhraseModal,
  RegenerateConfirmModal,
  LoginPage,
  ForgotPasswordPage,
  NewPasswordForm,
  RecoverySuccessView,
} from '../pages';
import {
  signUpAndVerify,
  uniqueEmail,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Recovery Phrase & Forgot Password', () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
  });

  test('recovery phrase → verify → forgot password → regenerate', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(TIMEOUTS.XLONG);
    const email = uniqueEmail('e2e-rec');
    // Display-cased input is the point of this test (exercises
    // normalizeUsername path). Inline random hex for collision resistance —
    // the helper returns canonical lowercase, which doesn't fit here.
    // Sized so the normalized form ("rec_test_<4 ts><6 hex>") fits the
    // 20-char USERNAME_REGEX cap: 9 + 4 + 6 = 19.
    const usernameRandom = [...crypto.getRandomValues(new Uint8Array(3))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const username = `Rec Test ${String(Date.now()).slice(-4)}${usernameRandom}`;
    const originalPassword = 'TestPassword123!';
    const recoveredPassword = 'RecoveredPassword789!';
    const usernameRecoveredPassword = 'UsernameRecovery456!';
    let capturedWords: string[] = [];

    await test.step('recovery phrase displays 12 words', async () => {
      await signUpAndVerify(unauthenticatedPage, request, {
        username,
        email,
        password: originalPassword,
      });

      await navigateToSettings(unauthenticatedPage);
      const settingsPage = new SettingsPage(unauthenticatedPage);
      await settingsPage.openRecoveryPhrase();

      const modal = new RecoveryPhraseModal(unauthenticatedPage);
      await expect(modal.wordGrid).toBeVisible({ timeout: TIMEOUTS.ASSERT });

      capturedWords = await modal.getWords();
      expect(capturedWords).toHaveLength(12);
      for (const word of capturedWords) {
        expect(word.length).toBeGreaterThan(0);
      }
    });

    await test.step('verify 3 random words saves recovery phrase', async () => {
      const modal = new RecoveryPhraseModal(unauthenticatedPage);
      await modal.proceedToVerify();

      await modal.fillVerificationWords(capturedWords);
      await modal.clickVerify();
      await modal.expectSuccess();

      await modal.doneButton.click();
    });

    await test.step('forgot password with recovery phrase resets password', async () => {
      await logoutViaUI(unauthenticatedPage);

      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.clickForgotPassword();

      const forgotPage = new ForgotPasswordPage(unauthenticatedPage);
      await forgotPage.fillRecoveryForm(email, capturedWords.join(' '));
      await forgotPage.submitRecovery();

      const newPwdForm = new NewPasswordForm(unauthenticatedPage);
      await newPwdForm.fillAndSubmit(recoveredPassword);

      const successView = new RecoverySuccessView(unauthenticatedPage);
      await successView.expectVisible();
    });

    await test.step('login with recovered password succeeds', async () => {
      const successView = new RecoverySuccessView(unauthenticatedPage);
      await successView.returnToLogin();

      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.loginAndWaitForChat(email, recoveredPassword);
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });

    await test.step('regenerate recovery phrase shows new words', async () => {
      await navigateToSettings(unauthenticatedPage);
      const settingsPage = new SettingsPage(unauthenticatedPage);
      await settingsPage.expectRecoveryPhraseBadge('Enabled');
      await settingsPage.openRecoveryPhrase();

      // Since phrase is already acknowledged, regenerate confirm modal appears
      const confirmModal = new RegenerateConfirmModal(unauthenticatedPage);
      await confirmModal.confirm();

      const modal = new RecoveryPhraseModal(unauthenticatedPage);
      await expect(modal.wordGrid).toBeVisible({ timeout: TIMEOUTS.ASSERT });

      const newWords = await modal.getWords();
      expect(newWords).toHaveLength(12);
      expect(newWords.join(' ')).not.toBe(capturedWords.join(' '));

      capturedWords = newWords;
    });

    await test.step('verify regenerated recovery phrase saves successfully', async () => {
      const modal = new RecoveryPhraseModal(unauthenticatedPage);
      await modal.proceedToVerify();

      await modal.fillVerificationWords(capturedWords);
      await modal.clickVerify();
      await modal.expectSuccess();
      await modal.doneButton.click();
    });

    await test.step('forgot password with username and recovery phrase resets password', async () => {
      await logoutViaUI(unauthenticatedPage);

      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.clickForgotPassword();

      const forgotPage = new ForgotPasswordPage(unauthenticatedPage);
      // Enter username naturally with spaces — frontend normalizes to stored format
      await forgotPage.fillRecoveryForm(username, capturedWords.join(' '));
      await forgotPage.submitRecovery();

      const newPwdForm = new NewPasswordForm(unauthenticatedPage);
      await newPwdForm.fillAndSubmit(usernameRecoveredPassword);

      const successView = new RecoverySuccessView(unauthenticatedPage);
      await successView.expectVisible();
    });

    await test.step('login with username and recovered password succeeds', async () => {
      const successView = new RecoverySuccessView(unauthenticatedPage);
      await successView.returnToLogin();

      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.loginAndWaitForChat(username, usernameRecoveredPassword);
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });
  });
});
