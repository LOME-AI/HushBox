import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { LoginPage } from '../pages';
import {
  logoutViaUI,
  clearAuthRateLimits,
  verifyEmailViaAPI,
  loginViaUI,
} from '../helpers/auth.js';
import { DEV_PASSWORD } from '../../packages/shared/src/constants.js';
import { personaEmail, personaUsername } from '../helpers/personas.js';

test.describe('Login & Session', () => {
  // File-level serial: the `Login variants` and `Session & route protection`
  // describes both authenticate as the same persona (`test-alice`). Without
  // file-level serial, Playwright's `fullyParallel` config lets them run in
  // different workers concurrently — they then race for the same Redis state.
  // The OPAQUE handshake itself is now sessionId-keyed (see
  // apps/api/src/lib/redis-registry.ts), so the race no longer corrupts the
  // server state, but a single shared persona still means concurrent logins
  // exercise overlapping rate-limit windows; serializing keeps the tests
  // deterministic.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test.describe('Login variants', () => {
    test('login with email navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.loginAndWaitForChat(personaEmail('test-alice'), DEV_PASSWORD);
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });

    test('login with username navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.loginAndWaitForChat(personaUsername('test-alice'), DEV_PASSWORD);
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });

    test('invalid password shows error', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-alice'), 'WrongPassword999!');
      await loginPage.expectError(/invalid|incorrect|failed/i);
    });

    test('unverified email redirects to check-email, verifying enables login', async ({
      unauthenticatedPage,
      request,
    }) => {
      // The initial login intentionally hits the EMAIL_NOT_VERIFIED branch
      // (401 from /api/auth/login/finish). Without these opt-outs the
      // auto-error-guard treats the 401 as an unexpected failure in the
      // After Hooks, the initial attempt is marked failed, and the retry
      // sees test-charlie already verified (by this test's own
      // verifyEmailViaAPI call) — so the check-your-email assertion can no
      // longer pass.
      expectApiErrors(unauthenticatedPage, [/EMAIL_NOT_VERIFIED/]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource.*401/,
        /the server responded with a status of 401/,
      ]);

      const email = personaEmail('test-charlie');
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(email, DEV_PASSWORD);

      await test.step('login redirects to check-your-email page', async () => {
        await expect(unauthenticatedPage.getByTestId('check-your-email')).toBeVisible({
          timeout: 10_000,
        });
        await expect(unauthenticatedPage.getByText(email)).toBeVisible();
        // CheckYourEmail fires resendVerification on mount when rendered from
        // the login flow. That call rotates users.emailVerifyToken, so the dev
        // endpoint must be read after it lands or the verify-email POST will
        // use a stale token and 400 with INVALID_OR_EXPIRED_TOKEN.
        await expect(unauthenticatedPage.getByTestId('resend-feedback')).toBeVisible({
          timeout: 10_000,
        });
      });

      await test.step('verify email via dev endpoint', async () => {
        await verifyEmailViaAPI(request, unauthenticatedPage, email);
      });

      await test.step('login succeeds after verification', async () => {
        await loginViaUI(unauthenticatedPage, { email, password: DEV_PASSWORD });
        await expect(unauthenticatedPage).toHaveURL('/chat');
      });
    });
  });

  test.describe('Session & route protection', () => {
    test('authenticated user visiting /login is redirected to /chat', async ({
      authenticatedPage,
    }) => {
      await authenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      await expect(authenticatedPage).toHaveURL('/chat', { timeout: 15_000 });
    });

    test('logout redirects to /login and /chat loads as trial user', async ({
      unauthenticatedPage,
    }) => {
      test.setTimeout(120_000);
      const page = unauthenticatedPage;

      await test.step('login to create an isolated session', async () => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.loginAndWaitForChat(personaEmail('test-alice'), DEV_PASSWORD);
      });

      await test.step('logout redirects to /login', async () => {
        await page
          .locator('[data-app-stable="true"]')
          .waitFor({ state: 'visible', timeout: 15_000 });
        await logoutViaUI(page);
        await expect(page).toHaveURL('/login');
      });

      await test.step('after logout, /chat loads as trial user', async () => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('textbox', { name: /ask me anything/i })).toBeVisible({
          timeout: 15_000,
        });
      });
    });
  });
});
