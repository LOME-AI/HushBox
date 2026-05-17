import { test, expect, unsettledExpect } from './fixtures.js';
import { LoginPage, SettingsPage, TwoFactorSetupModal, ChatPage } from './pages/index.js';
import {
  generateTOTPCode,
  signUpAndVerify,
  uniqueEmail,
  navigateToSettings,
  clearAuthRateLimits,
  waitForNextTOTPCode,
} from './helpers/auth.js';
import { requireEnv } from './helpers/env.js';
import { ROUTES } from '@hushbox/shared';
import type { Page, APIRequestContext, Locator } from '@playwright/test';

const apiUrl = requireEnv('VITE_API_URL');
const FRESH_PASSWORD = 'TestPassword123!';

// Post-delete redirect is a same-origin navigation to ROUTES.MARKETING.
// The Astro page may 404 in the E2E preview (only the Vite app is served)
// but the URL bar still commits to the path, which is what we assert.
async function expectRedirectedToMarketing(page: Page): Promise<void> {
  await unsettledExpect.poll(() => page.url(), { timeout: 15_000 }).toContain(ROUTES.MARKETING);
}

interface FreshUser {
  email: string;
  username: string;
  password: string;
}

async function provisionFreshUser(
  page: Page,
  request: APIRequestContext,
  prefix: string
): Promise<FreshUser> {
  const email = uniqueEmail(prefix);
  const username = `${prefix.slice(0, 3)}${String(Date.now()).slice(-6)}`;
  await signUpAndVerify(page, request, { username, email, password: FRESH_PASSWORD });
  return { email, username, password: FRESH_PASSWORD };
}

async function seedWalletBalance(
  request: APIRequestContext,
  email: string,
  balance: string
): Promise<void> {
  const response = await request.post(`${apiUrl}/api/dev/wallet-balance`, {
    data: { email, walletType: 'purchased', balance },
  });
  if (!response.ok()) {
    throw new Error(`Failed to seed wallet balance for ${email}: ${String(response.status())}`);
  }
}

async function enableTwoFactorViaUI(page: Page): Promise<string> {
  await navigateToSettings(page);
  const settingsPage = new SettingsPage(page);
  await settingsPage.openTwoFactor();

  const setupModal = new TwoFactorSetupModal(page);
  await setupModal.start();
  const secret = await setupModal.waitForSecret();
  await setupModal.continueToVerify();

  const code = generateTOTPCode(secret);
  await setupModal.enterCode(code);
  await setupModal.verify();
  await setupModal.expectSuccess();
  await setupModal.done();

  return secret;
}

function modalLocator(page: Page): Locator {
  return page.getByTestId('delete-account-modal');
}

async function openDeleteAccountModal(page: Page): Promise<Locator> {
  await navigateToSettings(page);
  await page.getByTestId('delete-account-trigger').click();
  const modal = modalLocator(page);
  await expect(modal).toBeVisible();
  return modal;
}

async function continueFromIntro(page: Page): Promise<void> {
  await page.getByTestId('delete-account-intro-continue').click();
}

async function continueFromWallet(page: Page): Promise<void> {
  await page.getByTestId('delete-account-forfeit-checkbox').click();
  await page.getByTestId('delete-account-wallet-continue').click();
}

async function advanceThroughIntroAndWallet(page: Page): Promise<void> {
  await continueFromIntro(page);
  const forfeit = page.getByTestId('delete-account-forfeit-checkbox');
  if (await forfeit.isVisible().catch(() => false)) {
    await forfeit.click();
    await page.getByTestId('delete-account-wallet-continue').click();
  }
}

async function submitPasswordStep(page: Page, password: string): Promise<void> {
  await page.locator('#delete-account-password').fill(password);
  const initWait = page.waitForResponse(
    (response) =>
      response.url().includes('/api/auth/delete-account/init') &&
      response.request().method() === 'POST'
  );
  await page.getByTestId('delete-account-password-continue').click();
  await initWait;
}

async function typeConfirmationAndDelete(page: Page): Promise<void> {
  await page.getByTestId('delete-account-confirmation-input').fill('delete my account');
  const finishWait = page.waitForResponse(
    (response) =>
      response.url().includes('/api/auth/delete-account/finish') &&
      response.request().method() === 'POST'
  );
  await page.getByTestId('delete-account-final-submit').click();
  const finishResponse = await finishWait;
  expect(finishResponse.status()).toBe(204);
}

test.describe('Account deletion', () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
  });

  test.describe('Happy path: no 2FA', () => {
    test('signed-up user deletes account and is redirected to marketing root', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(120_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-no2fa');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await typeConfirmationAndDelete(unauthenticatedPage);

      await expectRedirectedToMarketing(unauthenticatedPage);

      await unauthenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(user.email, user.password);
      await loginPage.expectError(/login failed/i);
    });
  });

  test.describe('Happy path: with 2FA', () => {
    test('user with 2FA enters TOTP then deletes account', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(180_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-2fa');
      const secret = await enableTwoFactorViaUI(unauthenticatedPage);

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      const totpCode = await waitForNextTOTPCode(secret, generateTOTPCode(secret));
      const otpInput = unauthenticatedPage.getByTestId('otp-input');
      await expect(otpInput).toBeVisible({ timeout: 10_000 });
      await otpInput.pressSequentially(totpCode);
      await unauthenticatedPage.getByTestId('delete-account-totp-continue').click();

      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      await unauthenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(user.email, user.password);
      await loginPage.expectError(/login failed/i);
    });
  });

  test.describe('Wallet forfeit step', () => {
    test('non-zero balance surfaces forfeit step and gates Continue on the checkbox', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(120_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wallet');
      await seedWalletBalance(request, user.email, '5.00');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);

      const forfeit = unauthenticatedPage.getByTestId('delete-account-forfeit-checkbox');
      const continueButton = unauthenticatedPage.getByTestId('delete-account-wallet-continue');

      await expect(forfeit).toBeVisible();
      await expect(unauthenticatedPage.getByText('$5.00').first()).toBeVisible();
      await expect(continueButton).toBeDisabled();

      await forfeit.click();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      await expect(unauthenticatedPage.locator('#delete-account-password')).toBeVisible();
    });
  });

  test.describe('Back button', () => {
    test('back navigates through previous steps and is hidden on intro', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(120_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-back');
      await seedWalletBalance(request, user.email, '3.00');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });

      await openDeleteAccountModal(unauthenticatedPage);
      // The Back button is rendered by OverlayNavButtons as a sibling of
      // OverlayContent (which carries the `delete-account-modal` testid),
      // so we scope to the dialog itself, not the modal's content wrapper.
      const backButton = unauthenticatedPage
        .getByRole('dialog', { name: 'Delete account' })
        .getByRole('button', { name: 'Back' });

      await expect(backButton).toHaveCount(0);

      await continueFromIntro(unauthenticatedPage);
      await expect(unauthenticatedPage.getByText('$3.00').first()).toBeVisible();
      await expect(backButton).toBeVisible();

      await continueFromWallet(unauthenticatedPage);
      await expect(unauthenticatedPage.locator('#delete-account-password')).toBeVisible();

      await backButton.click();
      await expect(unauthenticatedPage.getByText('$3.00').first()).toBeVisible();

      await backButton.click();
      await expect(
        unauthenticatedPage.getByRole('heading', { name: /delete your account/i })
      ).toBeVisible();
      await expect(backButton).toHaveCount(0);
    });
  });

  test.describe('Shared content after deletion', () => {
    test('shared message link returns an error once the owner deletes their account', async ({
      unauthenticatedPage,
      createPage,
      request,
    }) => {
      test.setTimeout(180_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-share');

      const convResponse = await request.post(`${apiUrl}/api/dev/conversation`, {
        data: {
          ownerEmail: user.email,
          messages: [
            { content: 'Hello, please share this', senderType: 'user' },
            { content: 'Echo: sharing this assistant reply', senderType: 'ai' },
          ],
        },
      });
      expect(convResponse.ok()).toBe(true);
      const { conversationId } = (await convResponse.json()) as { conversationId: string };

      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.gotoConversation(conversationId);
      await chatPage.waitForConversationLoaded();

      const aiMessage = chatPage.messageList.locator('[data-role="assistant"]').first();
      await aiMessage.hover();
      await aiMessage.getByRole('button', { name: 'Share' }).click();

      const shareModal = unauthenticatedPage.getByTestId('share-message-modal');
      await expect(shareModal).toBeVisible();
      await unauthenticatedPage.getByTestId('share-message-create-button').click();

      const urlEl = unauthenticatedPage.getByTestId('share-message-url');
      await expect(urlEl).toBeVisible();
      const shareUrl = (await urlEl.textContent()) ?? '';
      expect(shareUrl).toContain('/share/m/');
      await unauthenticatedPage.keyboard.press('Escape');

      const guestBeforeDelete = await createPage();
      await guestBeforeDelete.goto(shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(guestBeforeDelete.getByTestId('shared-message-loading')).not.toBeVisible({
        timeout: 15_000,
      });
      await expect(guestBeforeDelete.getByTestId('shared-message-error')).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      const guestAfterDelete = await createPage();
      await guestAfterDelete.goto(shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(guestAfterDelete.getByTestId('shared-message-error')).toBeVisible({
        timeout: 15_000,
      });
    });
  });

  test.describe('Cancel at each step', () => {
    test('cancel from intro, wallet, password, and final closes modal and leaves account intact', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(180_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-cancel');
      await seedWalletBalance(request, user.email, '2.50');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });
      const modal = modalLocator(unauthenticatedPage);

      await openDeleteAccountModal(unauthenticatedPage);
      await unauthenticatedPage.getByTestId('delete-account-cancel').click();
      await expect(modal).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);
      await continueFromWallet(unauthenticatedPage);
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).not.toBeVisible();

      await unauthenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await expect(unauthenticatedPage).toHaveURL(/\/chat/);
    });
  });

  test.describe('Wrong password rejected', () => {
    test('incorrect password keeps modal on password step with friendly error', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(120_000);
      await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wrongpw');

      const modal = await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await unauthenticatedPage.locator('#delete-account-password').fill('Wrong-Password-1!');
      // OPAQUE init is constant-time and returns 200 even for a wrong
      // password; the mismatch only surfaces when finishLogin throws
      // client-side, so wait on /init rather than /finish.
      const initWait = unauthenticatedPage.waitForResponse(
        (response) =>
          response.url().includes('/api/auth/delete-account/init') &&
          response.request().method() === 'POST'
      );
      await unauthenticatedPage.getByTestId('delete-account-password-continue').click();
      const initResponse = await initWait;
      expect(initResponse.status()).toBe(200);

      await expect(modal.getByRole('alert')).toContainText(/incorrect password/i);
      await expect(modal.getByTestId('delete-account-password-continue')).toBeVisible();
    });
  });

  test.describe('Wrong TOTP rejected', () => {
    test('invalid TOTP from final-step submit routes back to TOTP step with friendly error', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(180_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wrongtotp');
      await enableTwoFactorViaUI(unauthenticatedPage);

      const modal = await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      // Enter a wrong TOTP code and advance past the TOTP step — the server
      // doesn't see the code until /finish, so we have to reach the final step
      // and submit the phrase to exercise the wrong-TOTP path.
      const otpInput = unauthenticatedPage.getByTestId('otp-input');
      await expect(otpInput).toBeVisible({ timeout: 10_000 });
      await otpInput.pressSequentially('000000');
      await unauthenticatedPage.getByTestId('delete-account-totp-continue').click();

      // Final step — type phrase and submit
      await unauthenticatedPage
        .getByTestId('delete-account-confirmation-input')
        .fill('delete my account');
      const finishWait = unauthenticatedPage.waitForResponse(
        (response) =>
          response.url().includes('/api/auth/delete-account/finish') &&
          response.request().method() === 'POST'
      );
      await unauthenticatedPage.getByTestId('delete-account-final-submit').click();
      const finishResponse = await finishWait;
      expect(finishResponse.status()).toBe(400);

      // After my fix: modal auto-navigates back to TOTP step with the error visible there.
      await expect(modal.getByTestId('otp-input')).toBeVisible();
      await expect(modal.getByText(/invalid verification code/i)).toBeVisible();
    });
  });

  test.describe('Phrase gating on step 5', () => {
    test('wrong phrase keeps submit disabled; exact phrase enables it', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(120_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-phrase');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      const input = unauthenticatedPage.getByTestId('delete-account-confirmation-input');
      const submit = unauthenticatedPage.getByTestId('delete-account-final-submit');

      await input.fill('delete account');
      await expect(submit).toBeDisabled();

      await input.fill('delete my account');
      await expect(submit).toBeEnabled();
    });
  });

  test.describe('Rate-limit lockout', () => {
    // The lockout counter only ticks on /finish with a bad ke3
    // (verifyOpaqueGate -> recordDeleteAccountFailure). The UI never reaches
    // that branch with a wrong password — finishLogin throws client-side after
    // /init succeeds — so an E2E test cannot increment the counter without
    // forging /init+/finish pairs by hand outside the modal. The route-level
    // lockout behavior is covered exhaustively in
    // apps/api/src/routes/delete-account.test.ts (lockout headers,
    // retryAfterSeconds, 24h TTL, etc.).
    test.fixme('fourth failed attempt surfaces lockout error', () => {
      // Intentionally empty — see rationale above.
    });
  });

  test.describe('Front-end idempotency', () => {
    test('final submit disables on click so double-click cannot fire twice', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(120_000);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-idem');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      let finishCount = 0;
      await unauthenticatedPage.route('**/api/auth/delete-account/finish', async (route) => {
        finishCount++;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });

      await unauthenticatedPage
        .getByTestId('delete-account-confirmation-input')
        .fill('delete my account');
      const submit = unauthenticatedPage.getByTestId('delete-account-final-submit');

      await submit.click();
      // The real guard: the button becomes disabled immediately after the
      // click while the mutation is pending. A disabled button does not fire
      // onClick events in any browser, so a user double-clicking can't issue
      // a second request.
      await expect(submit).toBeDisabled();

      await expectRedirectedToMarketing(unauthenticatedPage);
      expect(finishCount).toBe(1);
    });
  });
});
