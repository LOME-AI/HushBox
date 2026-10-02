import { generateRecoveryPhrase } from '@hushbox/crypto';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
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
  loginViaUI,
  uniqueEmail,
  uniqueUsername,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import {
  expectConversationStillReadable,
  saveRecoveryPhrase,
  seedAccountWithConversation,
} from '../helpers/credential-rotation.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Canary, SeedAccount } from '../helpers/credential-rotation.js';
import type { APIRequestContext, Page } from '../fixtures.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The one answer the reset form gives to "that phrase did not open this
 * account", pinned here verbatim. It is deliberately the same sentence for a
 * phrase that never belonged to the account and for one that regeneration
 * superseded — a second message would turn the form into an enumeration oracle.
 */
const PHRASE_REFUSED_MESSAGE = "That recovery phrase doesn't match this account.";

/**
 * Opt a page out of both channels for the two 401s a logout leaves behind on a
 * conversation route. `signOutAndClearCache` ends in a page reload, which lands
 * back on that route, and `beforeLoad` in `apps/web/src/routes/_app/chat.$id.tsx`
 * fires the conversation and keychain prefetches deliberately *before* awaiting
 * `requireAuth` — so on the now-cleared session exactly those two reads reach
 * the API anonymously and are denied, and none of the route's others do.
 *
 * The API patterns are anchored on method, status and the exact path shape
 * because the body code on these is the generic `UNAUTHORIZED`: matching the
 * body would allow every 401 the suite can produce instead of these two.
 *
 * The console pattern cannot be narrowed the same way — the guard filters
 * console lines by text alone and a resource-load error carries no URL — so the
 * status is the whole scope: a 403 or 500 on these routes still surfaces, as
 * does every console error that is not a resource load.
 */
function expectLogoutReloadPrefetchErrors(page: Page): void {
  expectApiErrors(page, [
    /\b401\b.* GET \S+\/conversations\/[0-9a-f-]{36}$/m,
    /\b401\b.* GET \S+\/conversations\/[0-9a-f-]{36}\/keychain$/m,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: the server responded with a status of 401/]);
}

/** One trip through the reset form: who it names, and the words it offers. */
interface ResetAttempt {
  readonly identifier: string;
  readonly phrase: string[];
}

/** Open the reset form on a logged-out page with the attempt's identifier and phrase entered. */
async function startReset(
  page: Page,
  request: APIRequestContext,
  attempt: ResetAttempt
): Promise<ForgotPasswordPage> {
  // Each recovery surface reserves two counters per identifier: a ceiling, and
  // a tighter window keyed on that identifier and the caller's network
  // together. Nothing clears either on success: every recovery response is
  // identical by design, so there is no verified outcome to clear on.
  await clearAuthRateLimits(request, [attempt.identifier]);

  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.clickForgotPassword();

  const forgotPage = new ForgotPasswordPage(page);
  await forgotPage.fillRecoveryForm(attempt.identifier, attempt.phrase.join(' '));
  await forgotPage.submitRecovery();
  return forgotPage;
}

/** A reset that must succeed: phrase accepted at step 1, new password set. */
async function resetPassword(
  page: Page,
  request: APIRequestContext,
  attempt: ResetAttempt,
  newPassword: string
): Promise<void> {
  await startReset(page, request, attempt);
  await new NewPasswordForm(page).fillAndSubmit(newPassword);
  await new RecoverySuccessView(page).expectVisible();
}

/** A reset that must be refused at step 1, before any password form exists. */
async function expectResetRefused(
  page: Page,
  request: APIRequestContext,
  attempt: ResetAttempt
): Promise<void> {
  const forgotPage = await startReset(page, request, attempt);
  await forgotPage.expectPhraseError(PHRASE_REFUSED_MESSAGE);
  await new NewPasswordForm(page).expectNotReached();
}

test.describe('Recovery Phrase & Forgot Password', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    // The accounts these journeys reset are minted inside each test, so there
    // is no account to name here; `startReset` names each attempt's own.
    await clearAuthRateLimits(request, []);
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
      await modal.confirmPassword(originalPassword);
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
      // The password reset above is what this account now authenticates with.
      await modal.confirmPassword(recoveredPassword);
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

  test('wrong phrase refused → two resets in a row → conversation still decrypts', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(TIMEOUTS.XXLONG);
    const page = unauthenticatedPage;
    expectLogoutReloadPrefetchErrors(page);
    const account: SeedAccount = {
      username: uniqueUsername('rec'),
      email: uniqueEmail('e2e-recgate'),
      password: 'InitialPassword123!',
    };
    const firstResetPassword = 'FirstResetPassword456!';
    const secondResetPassword = 'SecondResetPassword789!';
    // A real BIP-39 phrase belonging to nothing here, so it clears the checksum
    // check and reaches the account. Mistyping the account's own words would
    // fail the checksum instead and never exercise the gate at all.
    const strangerPhrase = generateRecoveryPhrase().split(' ');

    let phrase: string[] = [];
    let canary: Canary = { conversationId: '', text: '' };

    await test.step('register, save the phrase, write one encrypted turn', async () => {
      ({ phrase, canary } = await seedAccountWithConversation(
        page,
        request,
        account,
        `Recovery canary ${String(Date.now())}`
      ));
      await logoutViaUI(page);
    });

    await test.step('a phrase belonging to no account here is refused at step 1', async () => {
      await expectResetRefused(page, request, {
        identifier: account.email,
        phrase: strangerPhrase,
      });
    });

    await test.step('the refusal consumed nothing: the original password still opens the conversation', async () => {
      await expectConversationStillReadable(
        page,
        { email: account.email, password: account.password },
        canary
      );
      await logoutViaUI(page);
    });

    await test.step('first reset, then the conversation reads back', async () => {
      await resetPassword(page, request, { identifier: account.email, phrase }, firstResetPassword);
      await expectConversationStillReadable(
        page,
        { email: account.email, password: firstResetPassword },
        canary
      );
      await logoutViaUI(page);
    });

    await test.step('second reset on the same phrase, and the conversation still reads back', async () => {
      // A gate that works once and wedges on the next attempt passes every other
      // test in this suite; so does a reset that quietly substitutes the account
      // key, because the turn written before reset one is the only thing that
      // would notice.
      await resetPassword(
        page,
        request,
        { identifier: account.email, phrase },
        secondResetPassword
      );
      await expectConversationStillReadable(
        page,
        { email: account.email, password: secondResetPassword },
        canary
      );
    });
  });

  test('regenerated phrase resets → superseded phrase refused', async ({
    unauthenticatedPage,
    request,
  }) => {
    test.setTimeout(TIMEOUTS.XXLONG);
    const page = unauthenticatedPage;
    expectLogoutReloadPrefetchErrors(page);
    const account: SeedAccount = {
      username: uniqueUsername('reg'),
      email: uniqueEmail('e2e-recregen'),
      password: 'InitialPassword123!',
    };
    const newPassword = 'RegeneratedResetPassword456!';

    let originalPhrase: string[] = [];
    let canary: Canary = { conversationId: '', text: '' };

    await test.step('register, save the phrase, write one encrypted turn', async () => {
      ({ phrase: originalPhrase, canary } = await seedAccountWithConversation(
        page,
        request,
        account,
        `Regenerated canary ${String(Date.now())}`
      ));
    });

    const regeneratedPhrase = await test.step('regenerate the recovery phrase', async () => {
      const words = await saveRecoveryPhrase(page, account.password, true);
      expect(words.join(' ')).not.toBe(originalPhrase.join(' '));
      await logoutViaUI(page);
      return words;
    });

    await test.step('the regenerated phrase resets, and the conversation reads back', async () => {
      // The stored recovery public key and the stored recovery wrap are two
      // halves of one phrase. If regeneration moved only one of them, this reset
      // seals a challenge the phrase in hand cannot open — a divergence nothing
      // before this moment can see.
      await resetPassword(
        page,
        request,
        { identifier: account.email, phrase: regeneratedPhrase },
        newPassword
      );
      await expectConversationStillReadable(
        page,
        { email: account.email, password: newPassword },
        canary
      );
      await logoutViaUI(page);
    });

    await test.step('the superseded phrase no longer resets anything', async () => {
      await expectResetRefused(page, request, {
        identifier: account.email,
        phrase: originalPhrase,
      });
    });

    await test.step('and the password the regenerated phrase set still logs in', async () => {
      await loginViaUI(page, { email: account.email, password: newPassword });
      await expect(page).toHaveURL('/chat');
    });
  });
});
