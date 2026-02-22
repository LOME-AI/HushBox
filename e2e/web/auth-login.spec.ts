import { test, expect } from '../fixtures.js';
import { LoginPage } from '../pages';
import { logoutViaUI, clearAuthRateLimits } from '../helpers/auth.js';
import { DEV_PASSWORD } from '../../packages/shared/src/constants.js';

test.describe('Login & Session', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'chromium') {
      test.skip(true, 'Auth tests run only on chromium');
    }
    await clearAuthRateLimits(request);
  });

  test.describe('Login variants', () => {
    test.describe.configure({ mode: 'serial' });

    test('login with email navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.loginAndWaitForChat('test-alice@test.hushbox.ai', DEV_PASSWORD);
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });

    test('login with username navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.loginAndWaitForChat('test alice', DEV_PASSWORD);
      await expect(unauthenticatedPage).toHaveURL('/chat');
    });

    test('invalid password shows error', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login('test-alice@test.hushbox.ai', 'WrongPassword999!');
      await loginPage.expectError(/invalid|incorrect|failed/i);
    });

    test('unverified email shows error', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login('test-charlie@test.hushbox.ai', DEV_PASSWORD);
      await loginPage.expectError(/verified|verify/i);
    });
  });

  test.describe('Session & route protection', () => {
    test('authenticated user visiting /login is redirected to /chat', async ({
      authenticatedPage,
    }) => {
      await authenticatedPage.goto('/login');
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
        await loginPage.loginAndWaitForChat('test-alice@test.hushbox.ai', DEV_PASSWORD);
      });

      await test.step('logout redirects to /login', async () => {
        await page
          .locator('[data-app-stable="true"]')
          .waitFor({ state: 'visible', timeout: 15_000 });
        await logoutViaUI(page);
        await expect(page).toHaveURL('/login');
      });

      await test.step('after logout, /chat loads as trial user', async () => {
        await page.goto('/chat');
        // Trial user sees the chat page with prompt input visible
        await expect(page.getByRole('textbox', { name: /ask me anything/i })).toBeVisible({
          timeout: 15_000,
        });
      });
    });
  });
});
