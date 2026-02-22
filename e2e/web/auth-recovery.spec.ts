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

test.describe('Recovery Phrase & Forgot Password', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test('recovery phrase → verify → forgot password → regenerate', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(120_000);
    const email = uniqueEmail('e2e-rec');
    const username = `Rec Test ${String(Date.now()).slice(-6)}`;
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
      await expect(modal.wordGrid).toBeVisible({ timeout: 15_000 });

      capturedWords = await modal.getWords();
      expect(capturedWords).toHaveLength(12);
      // Every word should be non-empty
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
      await expect(modal.wordGrid).toBeVisible({ timeout: 15_000 });

      const newWords = await modal.getWords();
      expect(newWords).toHaveLength(12);
      // New words should be different from original
      expect(newWords.join(' ')).not.toBe(capturedWords.join(' '));

      // Update captured words for verification
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
