import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { LoginPage } from '../pages';
import {
  logoutViaUI,
  clearAuthRateLimits,
  verifyEmailViaAPI,
  loginViaUI,
} from '../helpers/auth.js';
import { DEV_PASSWORD } from '../../packages/shared/src/constants.js';
import { personaEmail, personaUsername } from '../helpers/personas.js';
import { waitForAppStable } from '../helpers/page-signals.js';
import { setupRealtimePair } from '../helpers/realtime.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

test.describe('Login & Session', SPEC_MATRIX, () => {
  test.beforeEach(async ({ request }) => {
    // The seeded personas this spec logs in as, under both identifier forms.
    // A login attempt spends two counters in one atomic check: the account-wide
    // ceiling keyed on the resolved account, and a tighter window keyed on that
    // account together with the caller's network. Only a verified login clears
    // either, so the invalid-password case leaves both spent, and the
    // per-network window — the smaller — is the one repeated runs reach first.
    await clearAuthRateLimits(request, [
      personaEmail('test-alice'),
      personaUsername('test-alice'),
      personaEmail('test-charlie'),
    ]);
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

    test('the cipher wall stands beside the form only where the pointer is fine', async ({
      unauthenticatedPage,
    }) => {
      // The wall needs a wide frame and a fine pointer. Every touch project here
      // is either narrow or, on the tablet, wide but coarse, so the project's
      // touch setting alone decides what the page must draw.
      const pointerIsFine = test.info().project.use.hasTouch !== true;
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await expect(loginPage.emailInput).toBeVisible();

      const wall = unauthenticatedPage.getByTestId(TEST_IDS.cipherWall);
      await expect(wall).toBeAttached();
      await expect(wall).toBeVisible({ visible: pointerIsFine });
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
      // (401 from /auth/login/finish). Without these opt-outs the
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
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible({
          timeout: TIMEOUTS.ASSERT,
        });
        await expect(unauthenticatedPage.getByText(email)).toBeVisible();
        // CheckYourEmail fires resendVerification on mount when rendered from
        // the login flow. That call rotates users.emailVerifyToken, so the dev
        // endpoint must be read after it lands or the verify-email POST will
        // use a stale token and 400 with INVALID_OR_EXPIRED_TOKEN.
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.resendFeedback)).toBeVisible({
          timeout: TIMEOUTS.ASSERT,
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
      await expect(authenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    test('logout leaves the unguarded chat route loaded as a trial user', async ({
      unauthenticatedPage,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const page = unauthenticatedPage;

      await test.step('login to create an isolated session', async () => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.loginAndWaitForChat(personaEmail('test-alice'), DEV_PASSWORD);
      });

      await test.step('logout keeps the page on /chat', async () => {
        await waitForAppStable(page);
        await logoutViaUI(page);
        // Sign-out reloads in place, and /chat carries no requireAuth guard, so
        // the cleared session lands back on the route it left. Only the guarded
        // routes send it to /login.
        await expect(page).toHaveURL('/chat');
      });

      await test.step('after logout, /chat loads as trial user', async () => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('textbox', { name: /ask me anything/i })).toBeVisible({
          timeout: TIMEOUTS.ROUTE,
        });
      });
    });

    test('signing out one device leaves the user’s other device streaming', async ({
      unauthenticatedPage,
      createPage,
      groupConversation,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const credentials = { email: personaEmail('test-alice'), password: DEV_PASSWORD };
      const phone = unauthenticatedPage;
      const laptop = await createPage();

      // Signing out with a conversation open leaves the phone's in-flight
      // conversation reads to answer 401. That is the revocation working;
      // without these opt-outs the auto-error-guard fails the test for it.
      expectApiErrors(phone, [/UNAUTHORIZED/]);
      expectConsoleErrors(phone, [
        /Failed to load resource.*401/,
        /the server responded with a status of 401/,
      ]);

      await test.step('sign one user in on two devices', async () => {
        // Two isolated sessions, never the shared fixture session: other specs
        // run against that one, and signing it out would revoke it for them.
        await loginViaUI(phone, credentials);
        await loginViaUI(laptop, credentials);
      });

      // A drop is observable only as an EVENT. The client reconnects on any
      // unexpected close and this laptop's session stays valid, so it recovers
      // within moments — a steady-state "still connected" assertion would hold
      // whether or not signing out the phone cut this socket.
      const phoneSocketCloses: string[] = [];
      const laptopSocketCloses: string[] = [];
      phone.on('websocket', (socket) => {
        socket.on('close', () => phoneSocketCloses.push(socket.url()));
      });
      laptop.on('websocket', (socket) => {
        socket.on('close', () => laptopSocketCloses.push(socket.url()));
      });

      // A GROUP conversation, because that is the only kind that holds a
      // socket: the client opens one only when the conversation has more than
      // one member. Without a live socket on each device the revocation
      // fan-out has nothing to close and this test would prove nothing.
      const { bobChatPage: laptopChat } = await setupRealtimePair(
        phone,
        laptop,
        groupConversation.id
      );

      await test.step('sign out on the phone', async () => {
        // No app-stable wait: the realtime pair setup already gated on this
        // page's conversation load and socket readiness, which are the stronger
        // signals, and the shell's stable flag is not raised on a conversation route.
        await logoutViaUI(phone);
        // The conversation route is requireAuth-guarded, so the sign-out reload
        // lands on it without a session and the guard sends it to /login.
        await expect(phone).toHaveURL('/login');
      });

      await test.step('the laptop is still streaming', async () => {
        // A drained-state check would return immediately on the seeded
        // conversation's already-settled state and assert nothing. This gates
        // on the cycle counter advancing, so it is both the real proof and the
        // happens-after fence below.
        await laptopChat.withStreamCycle(() => laptopChat.sendFollowUpMessage('Still here?'));
      });

      // Sequenced behind a full round trip over the laptop's own socket, so a
      // close the sign-out caused has long since arrived.
      expect(laptopSocketCloses).toEqual([]);
      expect(phoneSocketCloses.length).toBeGreaterThan(0);
    });
  });
});
