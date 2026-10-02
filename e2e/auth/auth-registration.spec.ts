import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { LoginPage, SidebarPage, SignupPage } from '../pages';
import {
  signUpAndVerify,
  signUpViaUI,
  verifyEmailViaAPI,
  loginViaUI,
  uniqueEmail,
  uniqueUsername,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import { fetchAcquisitionSource } from '../helpers/acquisition-source.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

test.describe('Registration & Verification', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request, []);
  });

  test('signup → verify → login succeeds', async ({ unauthenticatedPage, request }) => {
    test.setTimeout(TIMEOUTS.XLONG);
    const email = uniqueEmail('e2e-reg');
    const username = uniqueUsername('reg');
    const password = 'TestPassword123!';

    await test.step('signup with valid credentials shows "Check your email"', async () => {
      await signUpViaUI(unauthenticatedPage, request, { username, email, password });
      await expect(unauthenticatedPage.getByText('Check your email')).toBeVisible();
    });

    await test.step('verify email via dev API succeeds', async () => {
      await verifyEmailViaAPI(request, unauthenticatedPage, email);
      await expect(unauthenticatedPage).toHaveURL(/\/verify\?token=/, { timeout: TIMEOUTS.ROUTE });
      await expect(
        unauthenticatedPage.getByRole('heading', { name: /email verified/i })
      ).toBeVisible();
    });

    await test.step('login with new credentials navigates to /chat', async () => {
      await loginViaUI(unauthenticatedPage, { email, password });
      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });
  });

  test('the channel question is asked once after signup and never again once answered', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(TIMEOUTS.XLONG);
    const page = unauthenticatedPage;
    const email = uniqueEmail('e2e-channel');
    const username = uniqueUsername('chan');
    const password = 'TestPassword123!';

    // Answering the platform's notification question makes the notifications
    // offer ineligible, so the slot's one visible prompt is deterministically
    // the channel question rather than whichever the browser happened to allow.
    await page.context().grantPermissions(['notifications']);

    await test.step('sign up, verify and land in the app', async () => {
      await signUpAndVerify(page, request, { username, email, password });
      // The stored row, not the prompt: registration stamped where the account
      // came from, and nobody has answered or skipped the question yet.
      expect(await fetchAcquisitionSource(request, email)).toEqual({
        campaign: 'direct',
        platform: 'web',
        selfReportedChannel: null,
        selfReportedContext: null,
        selfReportSkipped: null,
      });
    });

    // A fresh desktop context lands with the sidebar open, but a phone lands
    // with the drawer shut and a remembered collapse lands on the rail, whose
    // slot carries a stand-in rather than the card; the body has to be on
    // screen before anything living in it can be read.
    const sidebar = new SidebarPage(page);

    await test.step('the post-signup question is the one prompt on screen', async () => {
      await sidebar.ensureSidebarExpanded();
      // Its presence is also the assertion that registration wrote the account's
      // acquisition row: the server offers this prompt only to an account that
      // carries one.
      await expect(
        page.getByRole('heading', { name: 'Where did you hear about HushBox?' })
      ).toBeVisible({ timeout: TIMEOUTS.ROUTE });
      // Counted inside the sidebar, which is where the slot lives: the app
      // carries live regions of its own — the route announcer among them — so
      // counting them page-wide would be counting the page, not the slot.
      await expect(sidebar.sidebar.getByRole('status')).toHaveCount(1);
    });

    await test.step('answering it retires the question for good', async () => {
      await page.getByRole('button', { name: 'Podcast' }).click();
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(
        page.getByRole('heading', { name: 'Where did you hear about HushBox?' })
      ).toBeHidden();

      await page.reload();
      await sidebar.ensureSidebarExpanded();
      await expect(
        page.getByRole('heading', { name: 'Where did you hear about HushBox?' })
      ).toBeHidden({ timeout: TIMEOUTS.ROUTE });

      // What the answer stored: the channel that was tapped, stamped with the
      // context it was answered in, and no skip behind it.
      expect(await fetchAcquisitionSource(request, email)).toEqual({
        campaign: 'direct',
        platform: 'web',
        selfReportedChannel: 'podcast',
        selfReportedContext: 'post_signup',
        selfReportSkipped: null,
      });
    });
  });

  test('the beta welcome comes before the signup form', async ({ unauthenticatedPage }) => {
    const signupPage = new SignupPage(unauthenticatedPage);
    await unauthenticatedPage.goto('/signup', { waitUntil: 'domcontentloaded' });

    await expect(signupPage.betaWelcomeHeading).toBeVisible();
    await expect(signupPage.usernameInput).toBeHidden();

    await signupPage.joinBetaButton.click();

    await expect(signupPage.usernameInput).toBeVisible();
    await expect(signupPage.betaWelcomeHeading).toBeHidden();
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

  test.describe('Email verification resend', () => {
    test('resend from signup success page', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const email = uniqueEmail('e2e-resend');
      const username = uniqueUsername('resend');
      const password = 'TestPassword123!';

      await test.step('sign up shows check-your-email with resend button', async () => {
        await signUpViaUI(unauthenticatedPage, request, { username, email, password });
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible();
        await expect(unauthenticatedPage.getByText(email)).toBeVisible();
      });

      await test.step('click resend shows success feedback and cooldown', async () => {
        const resendButton = unauthenticatedPage.getByTestId(TEST_IDS.resendButton);
        await expect(resendButton).toBeEnabled();
        await resendButton.click();

        const feedback = unauthenticatedPage.getByTestId(TEST_IDS.resendFeedback);
        await expect(feedback).toBeVisible();
        await expect(feedback).toContainText('Verification email sent.');

        await expect(resendButton).toBeDisabled();
        await expect(resendButton).toContainText(/\d+s/);
      });

      await test.step('verify with latest token and login', async () => {
        await verifyEmailViaAPI(request, unauthenticatedPage, email);
        await loginViaUI(unauthenticatedPage, { email, password });
        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
      });
    });

    test('verify with no token sends a new link only to a valid address', async ({
      unauthenticatedPage,
    }) => {
      const page = unauthenticatedPage;
      // The server answers an unknown address as it answers a known one, so the
      // page's request, reply and cooldown are the same for a fresh address; the
      // server's send path for a real account is not reached here.
      const email = uniqueEmail('e2e-verify-resend');

      let resendPosts = 0;
      page.on('request', (outbound) => {
        if (outbound.method() === 'POST' && outbound.url().includes('/auth/verify-email/resend')) {
          resendPosts += 1;
        }
      });

      await page.goto('/verify', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'No verification token' })).toBeVisible();
      const emailInput = page.getByLabel('Email', { exact: true });
      const resendButton = page.getByTestId(TEST_IDS.resendButton);
      const feedback = page.getByTestId(TEST_IDS.resendFeedback);

      await test.step('an invalid address is refused on the page', async () => {
        await emailInput.fill('not-an-address');
        await resendButton.click();

        await expect(
          page.getByRole('alert').filter({ hasText: 'Please enter a valid email' })
        ).toBeVisible();
        await expect(emailInput).toHaveAccessibleDescription(/valid email/);
        await expect(resendButton).toBeEnabled();
        await expect(resendButton).toHaveText('Resend verification email');
        await expect(feedback).toBeHidden();
      });

      await test.step('a valid address is sent once, then the button counts down', async () => {
        await emailInput.fill(email);
        await resendButton.click();

        await expect(feedback).toContainText('Verification email sent.');
        await expect(resendButton).toBeDisabled();
        await expect(resendButton).toHaveText(/\(\d+s\)/);
        const shownLabel = (await resendButton.textContent()) ?? '';
        expect(shownLabel).toMatch(/\(\d+s\)/);
        await expect(resendButton).not.toHaveText(shownLabel);

        // Counted after the send answered, so a request the refused address had
        // started would already be in the tally as a second one.
        expect(resendPosts).toBe(1);
      });
    });

    test('login unverified redirects to check-email with auto-resend', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      // Deliberate: logging in with an unverified email returns 401
      // EMAIL_NOT_VERIFIED, which the UI translates to a redirect to
      // /check-your-email plus an auto-resend.
      expectApiErrors(unauthenticatedPage, [
        /401 Unauthorized POST .*\/auth\/login\/finish/,
        /"code":"EMAIL_NOT_VERIFIED"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);
      const email = uniqueEmail('e2e-unverified');
      const username = uniqueUsername('unver');
      const password = 'TestPassword123!';

      await test.step('sign up but do not verify', async () => {
        await signUpViaUI(unauthenticatedPage, request, { username, email, password });
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible();
      });

      await test.step('login with unverified email shows check-your-email with auto-resend', async () => {
        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.goto();
        await loginPage.login(email, password);

        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible({
          timeout: TIMEOUTS.ROUTE,
        });
        await expect(unauthenticatedPage.getByText(email)).toBeVisible();

        const feedback = unauthenticatedPage.getByTestId(TEST_IDS.resendFeedback);
        await expect(feedback).toBeVisible({ timeout: TIMEOUTS.ASSERT });
        await expect(feedback).toContainText('Verification email sent.');

        const resendButton = unauthenticatedPage.getByTestId(TEST_IDS.resendButton);
        await expect(resendButton).toBeDisabled();
      });

      await test.step('verify with latest token and login', async () => {
        await verifyEmailViaAPI(request, unauthenticatedPage, email);
        await loginViaUI(unauthenticatedPage, { email, password });
        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
      });
    });
  });
});
