import { type Page, type Locator } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';

/** Click a button if it's still actionable within the timeout; swallow timeout errors (e.g. OTP auto-submit). */
async function clickIfActionable(button: Locator, timeout: number): Promise<void> {
  try {
    await button.click({ timeout });
  } catch {
    // Auto-submit already handled the action
  }
}

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly keepSignedInCheckbox: Locator;
  readonly forgotPasswordLink: Locator;
  readonly signupLink: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel('Email or Username');
    this.passwordInput = page.getByLabel('Password', { exact: true });
    this.loginButton = page.getByRole('button', { name: 'Log in' });
    this.keepSignedInCheckbox = page.getByLabel('Keep me signed in');
    this.forgotPasswordLink = page.getByRole('button', { name: 'Forgot password?' });
    this.signupLink = page.getByRole('link', { name: 'Sign up' });
    this.errorMessage = page.getByRole('alert');
  }

  async goto(): Promise<void> {
    await this.page.goto('/login', { waitUntil: 'domcontentloaded' });
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  async loginAndWaitForChat(email: string, password: string): Promise<void> {
    await this.login(email, password);
    await this.page.waitForURL('/chat', { timeout: TIMEOUTS.ROUTE });
  }

  async clickForgotPassword(): Promise<void> {
    await this.forgotPasswordLink.click();
  }

  async expectError(text: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toContainText(text);
  }
}

export class SignupPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly createAccountButton: Locator;
  readonly loginLink: Locator;
  readonly errorMessage: Locator;
  readonly betaWelcomeHeading: Locator;
  readonly joinBetaButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.betaWelcomeHeading = page.getByRole('heading', { name: 'Welcome to the HushBox beta' });
    this.joinBetaButton = page.getByRole('button', { name: 'Join the beta' });
    this.usernameInput = page.getByLabel('Username');
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByLabel('Password', { exact: true });
    this.confirmPasswordInput = page.getByLabel('Confirm password');
    this.createAccountButton = page.getByRole('button', { name: 'Create account' });
    this.loginLink = page.getByRole('link', { name: 'Log in' });
    this.errorMessage = page.getByRole('alert');
  }

  /** Opens `/signup` and passes the beta welcome, leaving the form on screen. */
  async goto(): Promise<void> {
    await this.page.goto('/signup', { waitUntil: 'domcontentloaded' });
    await this.joinBetaButton.click();
  }

  async fillForm(options: { username: string; email: string; password: string }): Promise<void> {
    await this.usernameInput.fill(options.username);
    await this.emailInput.fill(options.email);
    await this.passwordInput.fill(options.password);
    await this.confirmPasswordInput.fill(options.password);
  }

  async submit(): Promise<void> {
    await this.createAccountButton.click();
  }

  async signUp(options: { username: string; email: string; password: string }): Promise<void> {
    await this.fillForm(options);
    await this.submit();
  }

  async expectCheckYourEmail(): Promise<void> {
    await expect(this.page.getByText('Check your email')).toBeVisible({ timeout: TIMEOUTS.ROUTE });
  }

  async expectError(text: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toContainText(text);
  }
}

export class SettingsPage {
  readonly page: Page;
  readonly changePasswordButton: Locator;
  readonly twoFactorButton: Locator;
  readonly recoveryPhraseButton: Locator;
  readonly customInstructionsButton: Locator;
  readonly needsAttention: Locator;

  constructor(page: Page) {
    this.page = page;
    this.needsAttention = page.getByTestId(TEST_IDS.needsAttention);
    this.changePasswordButton = page.getByRole('button', { name: 'Change Password' });
    this.twoFactorButton = page.getByRole('button', { name: 'Two-Factor Authentication' });
    this.recoveryPhraseButton = page.getByRole('button', { name: 'Recovery Phrase' });
    this.customInstructionsButton = page.getByRole('button', { name: 'Custom Instructions' });
  }

  async goto(): Promise<void> {
    await this.page.goto('/settings', { waitUntil: 'domcontentloaded' });
  }

  async openChangePassword(): Promise<void> {
    await this.changePasswordButton.click();
  }

  async openTwoFactor(): Promise<void> {
    await this.twoFactorButton.click();
  }

  async openRecoveryPhrase(): Promise<void> {
    await this.recoveryPhraseButton.click();
  }

  async openCustomInstructions(): Promise<void> {
    await this.customInstructionsButton.click();
  }

  async expectTwoFactorBadge(label: string): Promise<void> {
    const badge = this.twoFactorButton.locator('[data-slot="badge"]', { hasText: label });
    await expect(badge).toBeVisible();
  }

  async expectRecoveryPhraseBadge(label: string): Promise<void> {
    const badge = this.recoveryPhraseButton.locator('[data-slot="badge"]', { hasText: label });
    await expect(badge).toBeVisible();
  }

  async expectCustomInstructionsBadge(label: string): Promise<void> {
    const badge = this.customInstructionsButton.locator('[data-slot="badge"]', { hasText: label });
    await expect(badge).toBeVisible();
  }
}

export class TwoFactorSetupModal {
  readonly page: Page;
  readonly modal: Locator;
  readonly getStartedButton: Locator;
  readonly secretCode: Locator;
  readonly continueButton: Locator;
  readonly otpInput: Locator;
  readonly verifyButton: Locator;
  readonly doneButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.modal = page.getByTestId(TEST_IDS.twoFactorSetupModal);
    this.getStartedButton = this.modal.getByRole('button', { name: 'Get Started →' });
    this.secretCode = this.modal.locator('code');
    this.continueButton = this.modal.getByRole('button', { name: 'Continue →' });
    this.otpInput = this.modal.getByTestId(TEST_IDS.otpInput);
    this.verifyButton = this.modal.getByRole('button', { name: /Verify/ });
    this.doneButton = this.modal.getByRole('button', { name: 'Done' });
    this.errorMessage = this.modal.locator('.text-destructive');
  }

  async start(): Promise<void> {
    await this.getStartedButton.click();
  }

  async waitForSecret(): Promise<string> {
    await expect(this.secretCode).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    const secret = await this.secretCode.textContent();
    if (!secret) throw new Error('Could not extract TOTP secret');
    return secret.trim();
  }

  async continueToVerify(): Promise<void> {
    await this.continueButton.click();
  }

  async enterCode(code: string): Promise<void> {
    await this.otpInput.pressSequentially(code);
  }

  async verify(): Promise<void> {
    await clickIfActionable(this.verifyButton, TIMEOUTS.MODAL);
  }

  async expectSuccess(): Promise<void> {
    await expect(this.modal.getByText('Two-Factor Authentication Enabled')).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
  }

  async done(): Promise<void> {
    await this.doneButton.click();
  }
}

export class TwoFactorLoginStep {
  readonly page: Page;
  readonly step: Locator;
  readonly otpInput: Locator;
  readonly verifyButton: Locator;
  readonly errorMessage: Locator;
  readonly finishingHeading: Locator;
  readonly reloadButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.step = page.getByTestId(TEST_IDS.twoFactorLoginStep);
    this.otpInput = this.step.getByTestId(TEST_IDS.otpInput);
    this.verifyButton = this.step.getByRole('button', { name: 'Verify' });
    this.errorMessage = this.step.getByRole('alert');
    this.finishingHeading = this.step.getByRole('heading', { name: 'Finishing sign-in' });
    this.reloadButton = this.step.getByRole('button', { name: 'Reload' });
  }

  async waitForStep(): Promise<void> {
    await expect(this.step).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  }

  async enterCode(code: string): Promise<void> {
    await this.otpInput.pressSequentially(code);
  }

  async verify(): Promise<void> {
    await clickIfActionable(this.verifyButton, TIMEOUTS.MODAL);
  }

  async expectError(text: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toContainText(text);
  }

  /** The state a verified code lands in when the rest of the sign-in cannot finish. */
  async expectFinishingSignIn(): Promise<void> {
    await expect(this.finishingHeading).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(this.reloadButton).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  }
}

export class ChangePasswordModal {
  readonly page: Page;
  readonly modal: Locator;
  readonly currentPasswordInput: Locator;
  readonly newPasswordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.modal = page.getByTestId(TEST_IDS.changePasswordModal);
    this.currentPasswordInput = this.modal.getByLabel('Current Password');
    this.newPasswordInput = this.modal.getByLabel('New Password', { exact: true });
    this.confirmPasswordInput = this.modal.getByLabel('Confirm New Password');
    this.submitButton = this.modal.getByRole('button', { name: 'Change Password' });
    this.errorMessage = this.modal.locator('.text-destructive');
  }

  async fillAndSubmit(currentPassword: string, newPassword: string): Promise<void> {
    await this.currentPasswordInput.fill(currentPassword);
    await this.newPasswordInput.fill(newPassword);
    await this.confirmPasswordInput.fill(newPassword);
    await this.submitButton.click();
  }

  async expectError(text: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toContainText(text);
  }
}

export class RecoveryPhraseModal {
  readonly page: Page;
  readonly modal: Locator;
  readonly wordGrid: Locator;
  readonly copyButton: Locator;
  readonly savedButton: Locator;
  readonly doneButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.modal = page.getByTestId(TEST_IDS.recoveryPhraseModal);
    this.wordGrid = this.modal.getByTestId(TEST_IDS.wordGrid);
    this.copyButton = this.modal.getByRole('button', { name: /Copy/ });
    this.savedButton = this.modal.getByRole('button', { name: "I've written it down" });
    this.doneButton = this.modal.getByRole('button', { name: /Done|Continue to Payment/ });
  }

  async getWords(): Promise<string[]> {
    const words = await this.wordGrid.getByRole('listitem').allTextContents();
    return words.map((word) => word.trim());
  }

  async proceedToVerify(): Promise<void> {
    await this.savedButton.click();
  }

  async fillVerificationWord(inputIndex: number, word: string): Promise<void> {
    const inputs = this.modal.locator('input[type="text"]');
    await inputs.nth(inputIndex).fill(word);
  }

  async getVerificationLabels(): Promise<number[]> {
    const labels = this.modal.locator('label');
    const allTexts = await labels.allTextContents();
    const wordPattern = /Word #(\d+)/;
    return allTexts
      .map((text) => wordPattern.exec(text))
      .filter((match): match is RegExpExecArray => match?.[1] !== undefined)
      .map((match) => Number(match[1]) - 1); // 0-indexed
  }

  async fillVerificationWords(words: string[]): Promise<void> {
    const indices = await this.getVerificationLabels();
    for (const [inputIndex, wordIndex] of indices.entries()) {
      const word = words[wordIndex];
      if (word !== undefined) {
        await this.fillVerificationWord(inputIndex, word);
      }
    }
  }

  async clickVerify(): Promise<void> {
    await this.modal.getByRole('button', { name: /Verify/ }).click();
  }

  /**
   * The save is gated on an OPAQUE password step-up, so the word check is
   * followed by a password confirmation before anything is stored. Exact label:
   * the field's visibility toggle carries its own "Show password" label.
   */
  async confirmPassword(password: string): Promise<void> {
    await this.modal.getByLabel('Password', { exact: true }).fill(password);
    await this.modal.getByRole('button', { name: 'Replace recovery phrase' }).click();
  }

  async expectSuccess(): Promise<void> {
    await expect(this.modal.getByText('Recovery Phrase Saved')).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
  }
}

export class DisableTwoFactorModal {
  readonly page: Page;
  readonly modal: Locator;
  readonly passwordInput: Locator;
  readonly continueButton: Locator;
  readonly otpInput: Locator;
  readonly disableButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.modal = page.getByTestId(TEST_IDS.disableTwoFactorModal);
    this.passwordInput = this.modal.getByLabel('Current Password');
    this.continueButton = this.modal.getByRole('button', { name: 'Continue' });
    this.otpInput = this.modal.getByTestId(TEST_IDS.otpInput);
    this.disableButton = this.modal.getByRole('button', { name: 'Disable 2FA' });
    this.errorMessage = this.modal.locator('.text-destructive');
  }

  async fillPasswordAndContinue(password: string): Promise<void> {
    await this.passwordInput.fill(password);
    await this.continueButton.click();
  }

  async enterCodeAndDisable(code: string): Promise<void> {
    await this.otpInput.pressSequentially(code);
    await clickIfActionable(this.disableButton, TIMEOUTS.MODAL);
  }

  async expectError(text: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toContainText(text);
  }
}

export class ForgotPasswordPage {
  readonly page: Page;
  readonly identifierInput: Locator;
  readonly recoveryPhraseTextarea: Locator;
  readonly nextButton: Locator;
  readonly backToLoginButton: Locator;
  readonly phraseError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.identifierInput = page.getByLabel('Email or Username');
    this.recoveryPhraseTextarea = page.getByPlaceholder('Enter your 12-word recovery phrase');
    this.nextButton = page.getByRole('button', { name: 'Next' });
    this.backToLoginButton = page.getByRole('button', { name: 'Back to login' });
    // Scoped to the region the textarea's aria-describedby points at, so a page
    // -level alert from anywhere else cannot stand in for the field's own answer.
    this.phraseError = page.locator('#recovery-phrase-feedback').getByRole('alert');
  }

  async fillRecoveryForm(identifier: string, phrase: string): Promise<void> {
    await this.identifierInput.fill(identifier);
    await this.recoveryPhraseTextarea.fill(phrase);
  }

  async submitRecovery(): Promise<void> {
    await this.nextButton.click();
  }

  /**
   * The phrase step's own field-level answer, which is where a refused phrase is
   * reported. Budgeted at ROUTE rather than ASSERT: the step derives the
   * recovery key before it can know the phrase is wrong, so one Argon2id runs in
   * the browser between the click and this message.
   */
  async expectPhraseError(text: string | RegExp): Promise<void> {
    await expect(this.phraseError).toContainText(text, { timeout: TIMEOUTS.ROUTE });
  }
}

export class NewPasswordForm {
  readonly page: Page;
  readonly newPasswordInput: Locator;
  readonly confirmPasswordInput: Locator;
  readonly resetButton: Locator;
  readonly backButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newPasswordInput = page.getByLabel('New Password');
    this.confirmPasswordInput = page.getByLabel('Confirm Password');
    this.resetButton = page.getByRole('button', { name: 'Reset Password' });
    this.backButton = page.getByRole('button', { name: 'Back to recovery' });
    this.errorMessage = page.getByRole('alert');
  }

  async fillAndSubmit(password: string): Promise<void> {
    await this.newPasswordInput.fill(password);
    await this.confirmPasswordInput.fill(password);
    await this.resetButton.click();
  }

  /**
   * That the flow never advanced past the phrase step. Assert it only after the
   * phrase step's own error is visible — before that this passes vacuously,
   * because the form has not had time to appear either way.
   */
  async expectNotReached(): Promise<void> {
    await expect(this.newPasswordInput).toBeHidden();
  }
}

export class RecoverySuccessView {
  readonly page: Page;
  readonly returnToLoginButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.returnToLoginButton = page.getByRole('button', { name: 'Return to Login' });
  }

  async expectVisible(): Promise<void> {
    await expect(this.page.getByText('Password Reset Successful')).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
  }

  async returnToLogin(): Promise<void> {
    await this.returnToLoginButton.click();
  }
}

export class RegenerateConfirmModal {
  readonly page: Page;
  readonly confirmButton: Locator;
  readonly cancelButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.confirmButton = page.getByRole('button', { name: 'Generate New' });
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
  }

  async confirm(): Promise<void> {
    await this.confirmButton.click();
  }

  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }
}
