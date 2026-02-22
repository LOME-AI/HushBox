import { test, expect } from '../fixtures.js';
import { SignupPage } from '../pages';
import {
  signUpViaUI,
  verifyEmailViaAPI,
  loginViaUI,
  uniqueEmail,
  clearAuthRateLimits,
} from '../helpers/auth.js';

test.describe('Registration & Verification', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test('signup → verify → login succeeds', async ({ unauthenticatedPage, request }) => {
    test.setTimeout(120_000);
    const email = uniqueEmail('e2e-reg');
    const username = `reg${String(Date.now()).slice(-6)}`;
    const password = 'TestPassword123!';

    await test.step('signup with valid credentials shows "Check your email"', async () => {
      await signUpViaUI(unauthenticatedPage, { username, email, password });
      await expect(unauthenticatedPage.getByText('Check your email')).toBeVisible();
    });

    await test.step('verify email via dev API succeeds', async () => {
      await verifyEmailViaAPI(request, unauthenticatedPage, email);
      await expect(unauthenticatedPage).toHaveURL(/\/verify\?token=/, { timeout: 10_000 });
    });

    await test.step('login with new credentials navigates to /chat', async () => {
      await loginViaUI(unauthenticatedPage, { email, password });
      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: 30_000 });
    });
  });

  test.describe('Signup validation', () => {
    test('weak password shows validation error', async ({ unauthenticatedPage }) => {
      const signupPage = new SignupPage(unauthenticatedPage);
      await signupPage.goto();

      await signupPage.usernameInput.fill('validuser');
      await signupPage.emailInput.fill(uniqueEmail('e2e-weak'));
      await signupPage.passwordInput.fill('short');
      await signupPage.confirmPasswordInput.fill('short');
      await signupPage.submit();

      await expect(unauthenticatedPage.getByText(/at least 8 characters/i)).toBeVisible();
    });

    test('mismatched passwords shows validation error', async ({ unauthenticatedPage }) => {
      const signupPage = new SignupPage(unauthenticatedPage);
      await signupPage.goto();

      await signupPage.usernameInput.fill('validuser');
      await signupPage.emailInput.fill(uniqueEmail('e2e-mismatch'));
      await signupPage.passwordInput.fill('TestPassword123!');
      await signupPage.confirmPasswordInput.fill('DifferentPassword456!');
      await signupPage.submit();

      await expect(unauthenticatedPage.getByText(/do not match/i)).toBeVisible();
    });
  });
});
