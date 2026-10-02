import {
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  ERROR_CODES,
  ROUTES,
  TEST_IDS,
  formatLockoutMessage,
  friendlyErrorMessage,
  nanoUsdToDollarString,
} from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import { LoginPage, SettingsPage, TwoFactorSetupModal, ChatPage } from './pages/index.js';
import {
  generateTOTPCode,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  navigateToSettings,
  clearAuthRateLimits,
  getAcceptableTOTPCode,
} from './helpers/auth.js';
import { setWalletBalance } from './helpers/budget.js';
import { closeOverlay } from './helpers/overlay.js';
import { requireEnv } from './helpers/env.js';
import { grantedWelcomeCredit } from './helpers/exact-money.js';
import { idempotentPost } from './helpers/idempotent-request.js';
import { expectOkResponse } from './helpers/ok-response.js';
import { setupConversationWithSidebar } from './helpers/group-test-setup.js';
import { guestIp } from './helpers/guest-identity.js';
import { createInviteLink } from './helpers/invite-link.js';
import { personaEmail } from './helpers/personas.js';
import { openShareModalForMessage } from './helpers/share-message.js';
import { TIMEOUTS } from './config/timeouts.js';
import type { Page, APIRequestContext, Locator, Response as WireResponse } from './fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

const apiUrl = requireEnv('VITE_API_URL');
const FRESH_PASSWORD = 'TestPassword123!';

/**
 * What the forfeit step owes a freshly-registered account: the welcome credit
 * registration granted it, rendered through the same shared formatter the modal
 * itself uses. Derived from the constant that mints the grant, so the number the
 * user is asked to forfeit is the number they were given — a literal would
 * agree with a modal that displays the wrong balance.
 */
const WELCOME_CREDIT_DISPLAY = `$${nanoUsdToDollarString(String(grantedWelcomeCredit()))}`;

// Post-delete redirect to ROUTES.MARKETING. Gate on waitForURL, not the
// settled indicator, which can read true mid-navigation.
async function expectRedirectedToMarketing(page: Page): Promise<void> {
  await page.waitForURL(new RegExp(ROUTES.MARKETING), { timeout: TIMEOUTS.ROUTE });
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
  const username = uniqueUsername(prefix);
  await signUpAndVerify(page, request, { username, email, password: FRESH_PASSWORD });
  return { email, username, password: FRESH_PASSWORD };
}

/**
 * The delete-account password input is an HTML `id` (no associated label or
 * test-id), so it must be targeted by id.
 */
function deleteAccountPasswordField(page: Page): Locator {
  // eslint-disable-next-line playwright/no-raw-locators -- HTML id input; no semantic role/label/test-id to target
  return page.locator('#delete-account-password');
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
  return page.getByTestId(TEST_IDS.deleteAccountModal);
}

async function openDeleteAccountModal(page: Page): Promise<Locator> {
  await navigateToSettings(page);
  await page.getByTestId(TEST_IDS.deleteAccountTrigger).click();
  const modal = modalLocator(page);
  await expect(modal).toBeVisible();
  return modal;
}

async function continueFromIntro(page: Page): Promise<void> {
  await page.getByTestId(TEST_IDS.deleteAccountIntroContinue).click();
}

async function continueFromWallet(page: Page): Promise<void> {
  await page.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox).click();
  await page.getByTestId(TEST_IDS.deleteAccountWalletContinue).click();
}

async function advanceThroughIntroAndWallet(page: Page): Promise<void> {
  await continueFromIntro(page);
  // The wallet/forfeit step renders only for a user with a non-zero balance;
  // otherwise intro advances straight to the password step. Both are
  // deterministic end-states, so wait for whichever lands before branching —
  // reading forfeit visibility point-in-time would race the React transition
  // and silently skip the required forfeit step for a user with credits.
  const forfeit = page.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox);
  const passwordField = deleteAccountPasswordField(page);
  await expect(forfeit.or(passwordField)).toBeVisible();
  if (await forfeit.isVisible()) {
    await forfeit.click();
    await page.getByTestId(TEST_IDS.deleteAccountWalletContinue).click();
  }
}

async function submitPasswordStep(page: Page, password: string): Promise<void> {
  await deleteAccountPasswordField(page).fill(password);
  const initWait = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/account/delete/init') && response.request().method() === 'POST'
  );
  await page.getByTestId(TEST_IDS.deleteAccountPasswordContinue).click();
  await initWait;
}

async function typeConfirmationAndDelete(page: Page): Promise<void> {
  await page
    .getByTestId(TEST_IDS.deleteAccountConfirmationInput)
    .fill(DELETE_ACCOUNT_CONFIRMATION_PHRASE);
  const finishWait = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/account/delete/finish') &&
      response.request().method() === 'POST'
  );
  await page.getByTestId(TEST_IDS.deleteAccountFinalSubmit).click();
  const finishResponse = await finishWait;
  // Authoritative contract: /finish succeeds with 200 { success: true }
  // (mirrors logout), never 204 — pinned by the identity slice's integration
  // tests (`routes.integration.test.ts`). Only the status is read here: on
  // success the app immediately assigns `location.href = ROUTES.MARKETING`,
  // and reading the response body would race that navigation (the browser
  // evicts the body, throwing "No resource with given identifier found"). The
  // `{ success: true }` body shape is pinned at the integration layer, not
  // re-read across this navigating seam.
  expect(finishResponse.status()).toBe(200);
}

/**
 * Drives one full modal pass — correct password, wrong TOTP (`000000`), exact
 * confirmation phrase — and returns the `/finish` response. The correct
 * password is required to reach `/finish` at all (the OPAQUE client throws on
 * a wrong one right after `/init`); the wrong TOTP is what makes the attempt
 * fail server-side after the lockout slot has been reserved.
 */
async function submitFinishWithWrongTotp(page: Page, password: string): Promise<WireResponse> {
  await openDeleteAccountModal(page);
  await advanceThroughIntroAndWallet(page);
  await submitPasswordStep(page, password);

  const otpInput = page.getByTestId(TEST_IDS.otpInput);
  await expect(otpInput).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  await otpInput.pressSequentially('000000');
  await page.getByTestId(TEST_IDS.deleteAccountTotpContinue).click();

  await page
    .getByTestId(TEST_IDS.deleteAccountConfirmationInput)
    .fill(DELETE_ACCOUNT_CONFIRMATION_PHRASE);
  const finishWait = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/account/delete/finish') &&
      response.request().method() === 'POST'
  );
  await page.getByTestId(TEST_IDS.deleteAccountFinalSubmit).click();
  return finishWait;
}

/**
 * A spec cannot import `@hushbox/db`, so deletion's data consequence is proven
 * where rows can be read: hard deletion of the account's rows, with financial
 * rows pseudonymized rather than kept, by
 * `apps/api/src/slices/identity/domain/account/deletion.integration.test.ts`, which reads
 * them back after the delete; reclamation of its stored ciphertext by
 * `apps/api/src/slices/media/domain/reclaim-user.integration.test.ts`.
 */
test.describe('Account deletion', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request, []);
  });

  test.describe('Happy path: no 2FA', () => {
    test('signed-up user deletes account and is redirected to marketing root', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-no2fa');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await typeConfirmationAndDelete(unauthenticatedPage);

      await expectRedirectedToMarketing(unauthenticatedPage);

      await unauthenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(user.email, user.password);
      await loginPage.expectError(friendlyErrorMessage(ERROR_CODES.LOGIN_FAILED));
    });
  });

  test.describe('Happy path: with 2FA', () => {
    test('user with 2FA enters TOTP then deletes account', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-2fa');
      const secret = await enableTwoFactorViaUI(unauthenticatedPage);

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      const totpCode = await getAcceptableTOTPCode(request, user.email, secret);
      const otpInput = unauthenticatedPage.getByTestId(TEST_IDS.otpInput);
      await expect(otpInput).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await otpInput.pressSequentially(totpCode);
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountTotpContinue).click();

      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      await unauthenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(user.email, user.password);
      await loginPage.expectError(friendlyErrorMessage(ERROR_CODES.LOGIN_FAILED));
    });
  });

  test.describe('Wallet forfeit step', () => {
    test('non-zero balance surfaces forfeit step and gates Continue on the checkbox', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      // No seeded balance: registration's own welcome credit is the non-zero
      // balance, which is both the state a real deleting user is in and the one
      // amount here that can be derived instead of typed.
      await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wallet');

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);

      const forfeit = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox);
      const continueButton = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountWalletContinue);

      await expect(forfeit).toBeVisible();
      await expect(unauthenticatedPage.getByText(WELCOME_CREDIT_DISPLAY).first()).toBeVisible();
      await expect(continueButton).toBeDisabled();

      await forfeit.click();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      await expect(deleteAccountPasswordField(unauthenticatedPage)).toBeVisible();
    });
  });

  test.describe('Back button', () => {
    test('back navigates through previous steps and is hidden on intro', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      // Same derived grant as the forfeit-step test: the wallet step renders
      // because a fresh account holds its welcome credit.
      await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-back');

      await openDeleteAccountModal(unauthenticatedPage);
      // Back is the overlay's corner arrow, a sibling of OverlayContent (which
      // carries the `delete-account-modal` testid), on every step but the
      // balance step, which draws it in its footer; so we scope to the dialog
      // itself, not the modal's content wrapper.
      // Unnamed: the dialog is named by its visible step heading, which
      // changes on every step this test walks through.
      const backButton = unauthenticatedPage
        .getByRole('dialog')
        .getByRole('button', { name: 'Back' });

      await expect(backButton).toHaveCount(0);

      await continueFromIntro(unauthenticatedPage);
      await expect(unauthenticatedPage.getByText(WELCOME_CREDIT_DISPLAY).first()).toBeVisible();
      await expect(backButton).toBeVisible();

      await continueFromWallet(unauthenticatedPage);
      await expect(deleteAccountPasswordField(unauthenticatedPage)).toBeVisible();

      await backButton.click();
      await expect(unauthenticatedPage.getByText(WELCOME_CREDIT_DISPLAY).first()).toBeVisible();

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
      test.setTimeout(TIMEOUTS.XXLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-share');

      const convResponse = await idempotentPost(request, `${apiUrl}/dev/conversation`, {
        data: {
          ownerEmail: user.email,
          messages: [
            { content: 'Hello, please share this', senderType: 'user' },
            { content: 'Echo: sharing this assistant reply', senderType: 'ai' },
          ],
        },
      });
      await expectOkResponse(convResponse, 'dev conversation seed');
      const { conversationId } = (await convResponse.json()) as { conversationId: string };

      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.gotoConversation(conversationId);
      await chatPage.waitForConversationLoaded();

      const aiMessage = chatPage.messagesByRole('assistant').first();
      const shareModal = await openShareModalForMessage(unauthenticatedPage, aiMessage);
      await expect(shareModal).toBeVisible();
      await unauthenticatedPage.getByTestId(TEST_IDS.shareMessageCreateButton).click();

      const urlEl = unauthenticatedPage.getByTestId(TEST_IDS.shareMessageUrl);
      await expect(urlEl).toBeVisible();
      const shareUrl = (await urlEl.textContent()) ?? '';
      expect(shareUrl).toContain('/share/m/');
      await unauthenticatedPage.keyboard.press('Escape');

      const guestBeforeDelete = await createPage();
      await guestBeforeDelete.goto(shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(guestBeforeDelete.getByTestId(TEST_IDS.sharedMessageLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
      await expect(guestBeforeDelete.getByTestId(TEST_IDS.sharedMessageError)).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      const guestAfterDelete = await createPage();
      // Deliberate: this test asserts the share URL surfaces an error to a
      // guest once the owner deletes their account. The guest's GET against
      // the share endpoint resolves to 404 SHARE_NOT_FOUND.
      expectApiErrors(guestAfterDelete, [
        /404 Not Found GET .*\/conversations\/shared\/message\/[A-Za-z0-9_-]+/,
        /"code":"SHARE_NOT_FOUND"/,
      ]);
      expectConsoleErrors(guestAfterDelete, [
        /Failed to load resource: the server responded with a status of 404/,
      ]);
      await guestAfterDelete.goto(shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(guestAfterDelete.getByTestId(TEST_IDS.sharedMessageError)).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
    });
  });

  test.describe('Invite link minted by a departing member', () => {
    test('invite link stops resolving once the member who minted it deletes their account', async ({
      unauthenticatedPage,
      createPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const minter = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-link');

      // Seeded members are seated `admin`, which is the privilege link minting
      // requires; the owner is a persona, so the deletion under test removes the
      // link's creator without removing the conversation it lives in.
      const convResponse = await idempotentPost(request, `${apiUrl}/dev/group-chat`, {
        data: {
          ownerEmail: personaEmail('test-alice'),
          memberEmails: [minter.email],
          messages: [{ content: 'Seeded before the minter departs', senderType: 'user' }],
        },
      });
      await expectOkResponse(convResponse, 'dev group-chat seed');
      const { conversationId } = (await convResponse.json()) as { conversationId: string };

      const { sidebar } = await setupConversationWithSidebar(unauthenticatedPage, conversationId);
      const { url: inviteUrl } = await createInviteLink(unauthenticatedPage, sidebar, {
        withHistory: true,
        closeMethod: 'escape',
        extractLinkId: false,
      });
      expect(inviteUrl).toContain('/share/c/');

      const guestBeforeDelete = await createPage();
      await guestBeforeDelete.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      // Deliberate: opening an invite link fires user-auth prefetches of every
      // per-conversation resource before the link-guest context establishes,
      // and each 401s with NOT_AUTHENTICATED first.
      expectApiErrors(guestBeforeDelete, [
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+(?:\/(?:budgets|keychain|members|links))?(?=\?|\s|$)/,
        /"code":"NOT_AUTHENTICATED"/,
        // Deliberate: this page stays open across the deletion, so its funding and message
        // re-reads go through the now-dead link and refuse — the very revocation asserted.
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+\/(?:funding|messages)(?=\?|\s|$)/,
      ]);
      expectConsoleErrors(guestBeforeDelete, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);
      await guestBeforeDelete.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
      await expect(
        guestBeforeDelete.getByTestId(TEST_IDS.sharedConversationLoading)
      ).not.toBeVisible({ timeout: TIMEOUTS.CONVERSATION_LOAD });
      await expect(
        guestBeforeDelete.getByTestId(TEST_IDS.sharedConversationError)
      ).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, minter.password);
      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      const guestAfterDelete = await createPage();
      await guestAfterDelete.setExtraHTTPHeaders({ 'cf-connecting-ip': guestIp() });
      expectApiErrors(guestAfterDelete, [
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+(?:\/(?:budgets|keychain|members|links))?(?=\?|\s|$)/,
        /"code":"NOT_AUTHENTICATED"/,
        // Deliberate: the deletion kills the link, so the guest's funding and message reads
        // refuse — the dead link the visible shared-conversation error proves.
        /401 Unauthorized GET .*\/conversations\/[0-9a-f-]+\/(?:funding|messages)(?=\?|\s|$)/,
      ]);
      expectConsoleErrors(guestAfterDelete, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);
      await guestAfterDelete.goto(inviteUrl, { waitUntil: 'domcontentloaded' });

      await expect(guestAfterDelete.getByTestId(TEST_IDS.sharedConversationError)).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
    });
  });

  test.describe('Messages a departing member sent', () => {
    test('a departed member’s message reads as deleted to the owner while the owner’s own message still renders', async ({
      authenticatedPage,
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const member = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-msg');
      const ownerText = 'Written by the owner, who stays';
      const memberText = 'Written by the member, who departs';

      // The owner is the persona `authenticatedPage` is signed in as, so the
      // deletion under test removes the member's account and leaves the
      // conversation, and the owner's view of it, in place.
      const convResponse = await idempotentPost(request, `${apiUrl}/dev/group-chat`, {
        data: {
          ownerEmail: personaEmail('test-alice'),
          memberEmails: [member.email],
          messages: [
            { content: ownerText, senderType: 'user' },
            { content: memberText, senderType: 'user', senderEmail: member.email },
          ],
        },
      });
      await expectOkResponse(convResponse, 'dev group-chat seed');
      const { conversationId } = (await convResponse.json()) as { conversationId: string };

      const ownerChat = new ChatPage(authenticatedPage);
      await ownerChat.gotoConversation(conversationId);
      await ownerChat.waitForConversationLoaded();
      await expect(ownerChat.messageList.getByText(memberText)).toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, member.password);
      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      await ownerChat.gotoConversation(conversationId);
      await ownerChat.waitForConversationLoaded();
      await expect(ownerChat.messageList.getByTestId(TEST_IDS.messageDeleted)).toHaveText(
        'Message deleted'
      );
      await expect(ownerChat.messageList.getByText(memberText)).toHaveCount(0);
      await expect(ownerChat.messageList.getByText(ownerText)).toBeVisible();
    });
  });

  test.describe('Cancel at each step', () => {
    test('cancel from intro, password, and final, and close from wallet, each close the modal and leave the account intact', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-cancel');
      await setWalletBalance(request, user.email, 'purchased', '2.50');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });
      const modal = modalLocator(unauthenticatedPage);

      await openDeleteAccountModal(unauthenticatedPage);
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountCancel).click();
      await expect(modal).not.toBeVisible();

      // The balance step has no Cancel: its footer Back returns to the intro, and the
      // overlay's close control dismisses it.
      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);
      await expect(
        unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox)
      ).toBeVisible();
      await modal.getByRole('button', { name: 'Back' }).click();
      await expect(
        unauthenticatedPage.getByRole('heading', { name: /delete your account/i })
      ).toBeVisible();
      await continueFromIntro(unauthenticatedPage);
      await expect(
        unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox)
      ).toBeVisible();
      await closeOverlay(unauthenticatedPage);
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
      test.setTimeout(TIMEOUTS.XLONG);
      await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wrongpw');

      const modal = await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await deleteAccountPasswordField(unauthenticatedPage).fill('Wrong-Password-1!');
      // OPAQUE init is constant-time and returns 200 even for a wrong
      // password; the mismatch only surfaces when finishLogin throws
      // client-side, so wait on /init rather than /finish.
      const initWait = unauthenticatedPage.waitForResponse(
        (response) =>
          response.url().includes('/auth/account/delete/init') &&
          response.request().method() === 'POST'
      );
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountPasswordContinue).click();
      const initResponse = await initWait;
      expect(initResponse.status()).toBe(200);

      await expect(modal.getByRole('alert')).toContainText(
        friendlyErrorMessage(ERROR_CODES.INCORRECT_PASSWORD)
      );
      await expect(modal.getByTestId(TEST_IDS.deleteAccountPasswordContinue)).toBeVisible();
    });
  });

  test.describe('Wrong TOTP rejected', () => {
    test('invalid TOTP from final-step submit routes back to TOTP step with friendly error', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      // Deliberate: this test submits `000000` and asserts the 400 response.
      expectApiErrors(unauthenticatedPage, [
        /400 Bad Request POST .*\/auth\/account\/delete\/finish/,
        /"code":"INVALID_TOTP_CODE"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 400/,
      ]);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wrongtotp');
      await enableTwoFactorViaUI(unauthenticatedPage);

      const modal = await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      // Enter a wrong TOTP code and advance past the TOTP step — the server
      // doesn't see the code until /finish, so we have to reach the final step
      // and submit the phrase to exercise the wrong-TOTP path.
      const otpInput = unauthenticatedPage.getByTestId(TEST_IDS.otpInput);
      await expect(otpInput).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await otpInput.pressSequentially('000000');
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountTotpContinue).click();

      // Final step — type phrase and submit
      await unauthenticatedPage
        .getByTestId(TEST_IDS.deleteAccountConfirmationInput)
        .fill(DELETE_ACCOUNT_CONFIRMATION_PHRASE);
      const finishWait = unauthenticatedPage.waitForResponse(
        (response) =>
          response.url().includes('/auth/account/delete/finish') &&
          response.request().method() === 'POST'
      );
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountFinalSubmit).click();
      const finishResponse = await finishWait;
      expect(finishResponse.status()).toBe(400);

      // After my fix: modal auto-navigates back to TOTP step with the error visible there.
      await expect(modal.getByTestId(TEST_IDS.otpInput)).toBeVisible();
      await expect(
        modal.getByText(friendlyErrorMessage(ERROR_CODES.INVALID_TOTP_CODE))
      ).toBeVisible();
    });
  });

  test.describe('Phrase gating on step 5', () => {
    test('wrong phrase keeps submit disabled; exact phrase enables it', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-phrase');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      const input = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountConfirmationInput);
      const submit = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountFinalSubmit);

      await input.fill('delete account');
      await expect(submit).toBeDisabled();

      await input.fill(DELETE_ACCOUNT_CONFIRMATION_PHRASE);
      await expect(submit).toBeEnabled();
    });
  });

  test.describe('Rate-limit lockout', () => {
    // The deletion guessing gate admits a fixed number of failed step-ups
    // (IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig.maxAttempts, a 1-hour
    // window) before the next reservation locks with 403 DELETE_ACCOUNT_LOCKED.
    // The slot is reserved inside /finish BEFORE the proof/TOTP verdict, so the
    // UI-reachable path that burns an attempt without deleting the account is a
    // CORRECT password plus a WRONG TOTP code: the step-up proof verifies, the
    // TOTP gate rejects (400 INVALID_TOTP_CODE), and the reserved attempt is
    // never cleared. (A wrong password never reaches /finish — the OPAQUE
    // client throws after /init — so the bad-proof branch stays route-test
    // territory in the identity slice.) Each /finish consumes its step-up
    // handshake, so every attempt re-drives the modal from a fresh page load.
    // The lock count is discovered from the server, never hardcoded, so this
    // test tracks the registry config rather than a stale literal.
    test('consecutive failed step-ups surface the deletion lockout', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      expectApiErrors(unauthenticatedPage, [
        /400 Bad Request POST .*\/auth\/account\/delete\/finish/,
        /"code":"INVALID_TOTP_CODE"/,
        /403 Forbidden POST .*\/auth\/account\/delete\/finish/,
        /"code":"DELETE_ACCOUNT_LOCKED"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 400/,
        /Failed to load resource: the server responded with a status of 403/,
      ]);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-lockout');
      await enableTwoFactorViaUI(unauthenticatedPage);

      // Discover the lock point instead of hardcoding the registry count: each
      // wrong-TOTP /finish returns 400 INVALID_TOTP_CODE until the gate is
      // exhausted, at which point the next reservation returns 403
      // DELETE_ACCOUNT_LOCKED. The bound only guards against a broken lock
      // looping forever; the real config admits far fewer attempts.
      const MAX_LOCKOUT_PROBE_ATTEMPTS = 10;
      let locked: WireResponse | null = null;
      let failedAttempts = 0;
      for (let attempt = 0; attempt < MAX_LOCKOUT_PROBE_ATTEMPTS; attempt++) {
        const response = await submitFinishWithWrongTotp(unauthenticatedPage, user.password);
        if (response.status() === 403) {
          locked = response;
          break;
        }
        expect(response.status()).toBe(400);
        failedAttempts++;
        // The modal routes back to the TOTP step on INVALID_TOTP_CODE; the
        // reload resets its kept-mounted state so the next pass drives a
        // fresh /init handshake instead of resubmitting a consumed session.
        await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });
      }

      // The gate never locks the very first attempt, and must lock within the
      // probe bound.
      expect(failedAttempts).toBeGreaterThan(0);
      if (locked === null) {
        throw new Error('Deletion lockout never engaged within the probe bound');
      }
      expect(locked.status()).toBe(403);
      const body = (await locked.json()) as { code: string; details?: Record<string, unknown> };
      expect(body.code).toBe(ERROR_CODES.DELETE_ACCOUNT_LOCKED);
      const retryAfterSeconds = body.details?.['retryAfterSeconds'];
      expect(typeof retryAfterSeconds).toBe('number');
      // The modal renders formatLockoutMessage(retryAfterSeconds) from this
      // same response body, so the exact shared copy is derivable here.
      await expect(
        modalLocator(unauthenticatedPage).getByText(
          formatLockoutMessage(retryAfterSeconds as number)
        )
      ).toBeVisible();
    });
  });

  test.describe('Front-end idempotency', () => {
    test('final submit disables on click so double-click cannot fire twice', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-idem');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      // Hold `/finish` in-flight on a deterministic signal (not a wall-clock
      // sleep) so the assertion below observes the pending-disabled state. The
      // route is released only after the button is confirmed disabled, which is
      // the exact condition under test (gate on state, not time).
      let finishCount = 0;
      let releaseFinish!: () => void;
      const finishHeld = new Promise<void>((resolve) => {
        releaseFinish = resolve;
      });
      await unauthenticatedPage.route('**/auth/account/delete/finish', async (route) => {
        finishCount++;
        await finishHeld;
        await route.fallback();
      });

      await unauthenticatedPage
        .getByTestId(TEST_IDS.deleteAccountConfirmationInput)
        .fill(DELETE_ACCOUNT_CONFIRMATION_PHRASE);
      const submit = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountFinalSubmit);

      await submit.click();
      // The real guard: the button becomes disabled immediately after the
      // click while the mutation is pending. A disabled button does not fire
      // onClick events in any browser, so a user double-clicking can't issue
      // a second request.
      await expect(submit).toBeDisabled();
      releaseFinish();

      await expectRedirectedToMarketing(unauthenticatedPage);
      expect(finishCount).toBe(1);
    });
  });
});
