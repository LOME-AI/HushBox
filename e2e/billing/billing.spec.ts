import {
  ERROR_CODES,
  MIN_DEPOSIT_USD,
  ROUTES,
  TEST_IDS,
  dollarsToNanoUsd,
  friendlyErrorMessage,
  nanoUsdToDollarString,
} from '@hushbox/shared';
import { APP_RETURN_TO_BILLING_URL } from '@hushbox/shared/billing-portal';
import {
  test,
  expect,
  allowExternalHosts,
  expectApiErrors,
  expectConsoleErrors,
} from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { BillingPage } from '../pages';
import {
  clearAuthRateLimits,
  loginViaUI,
  signUpViaUI,
  uniqueEmail,
  uniqueUsername,
  verifyEmailViaAPI,
} from '../helpers/auth.js';
import { requireEnv } from '../helpers/env.js';
import {
  allowedMinimumDeposit,
  expectBalanceDelta,
  expectNoWalletMovement,
  readMoneyState,
} from '../helpers/exact-money.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

const GUARD_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'desktop',
  reason:
    'The refusal is decided in the pre-claim transaction and rendered as fixed card copy, so no rendering engine takes part; the signup it needs also spends the single localhost address the auth throttles count, which a second project running it concurrently would consume.',
});

const apiUrl = requireEnv('VITE_API_URL');

test.describe('Billing & Payments', SPEC_MATRIX, () => {
  test.describe('Billing Page', () => {
    test('displays balance and opens payment modal', async ({ authenticatedPage }) => {
      // Opening the modal mounts PaymentForm, which loads Helcim's version2.js
      // from secure.myhelcim.com when isLocalDev is false (CI). The @webhook
      // describes auto-opt into the billing hosts; this untagged Billing-Page
      // test must opt in explicitly, or the network allowlist aborts the script
      // load and fails teardown.
      allowExternalHosts(authenticatedPage);

      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.expectBalanceVisible();
      await expect(billingPage.addCreditsButton).toBeVisible();

      await billingPage.openPaymentModal();
      await expect(billingPage.amountInput).toBeVisible();
    });

    test('accepts an accented cardholder name', async ({ authenticatedPage }) => {
      allowExternalHosts(authenticatedPage);

      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '100',
        cardHolderName: 'José Müller',
        billingAddress: '123 Test Street',
        zip: '12345',
      });

      // The name check is client-side only, and it gates submission outright,
      // so a rejected name is a hard block on the only credit-loading path.
      await expect(billingPage.cardHolderNameInput).toHaveAttribute('aria-invalid', 'false');
      await expect(authenticatedPage.getByText('Name contains invalid characters')).toHaveCount(0);
    });
  });

  // Dev Mode tests use simulate buttons that render only in local dev (isLocalDev).
  // In CI, VITE_CI=true makes isLocalDev=false, so the buttons are hidden. @local-only
  // gates this describe out of CI (the CI matrix passes --grep-invert @local-only) while
  // keeping it in local runs, replacing the former in-body `test.skip(isCI, …)`.
  test.describe('Payment Flow (Dev Mode)', { tag: '@local-only' }, () => {
    test('simulates successful payment and updates balance', async ({ billingDevModePage }) => {
      const billingPage = new BillingPage(billingDevModePage);
      await billingPage.goto();

      const initialBalance = await billingPage.waitForBalanceLoaded();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('25');

      await billingPage.simulateSuccessButton.click();

      await billingPage.expectPaymentSuccess();

      await billingPage.closeSuccessAndReset();

      // Wait for balance to update (cache invalidation and refetch)
      await expect
        .poll(() => billingPage.getBalance(), { timeout: TIMEOUTS.MODAL })
        .toBe(initialBalance + 25);
    });

    test('simulates failed payment and shows error', async ({ billingFailurePage }) => {
      const billingPage = new BillingPage(billingFailurePage);
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();
      // The wallet as the server holds it. The rendered figure below is the
      // same number the page already had — a declined card never invalidates
      // the balance query, so comparing display to display would hold even if
      // the wallet had been credited.
      const before = await readMoneyState(billingFailurePage.request);

      await billingPage.simulateFailedPayment('10');

      await billingPage.closeErrorAndRetry();
      await billingFailurePage.keyboard.press('Escape');

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance);

      // The decline is terminal before this runs, which is what a negative
      // needs: no amount of waiting can establish one.
      await expectNoWalletMovement(billingFailurePage.request, before);
    });

    test('validates minimum deposit amount', async ({ billingValidationPage }) => {
      const billingPage = new BillingPage(billingValidationPage);
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('2'); // Below $5 minimum

      const amountInput = billingPage.amountInput;
      await expect(amountInput).toHaveAttribute('aria-invalid', 'true');
    });
  });

  // Full payment flow tests run both locally (with mocks) and in CI (with real Helcim
  // sandbox). Locally: mock Helcim.js tokenizes, mock API processes, mock webhook delivers.
  // CI: real Helcim.js tokenizes, real API processes, real webhook via Hookdeck — only one
  // Hookdeck listener, so these run on the chromium runner only. @webhook gates them to that
  // runner in CI, replacing the former `SKIP_WEBHOOK_TESTS` in-body skip.
  test.describe('Payment Flow (Full)', { tag: '@webhook' }, () => {
    // Increase timeout for real payment tests (webhook may take time)
    test.setTimeout(TIMEOUTS.LONG);

    test('completes full payment flow: card → API → webhook → balance', async ({
      billingSuccessPage,
    }, testInfo) => {
      // This test verifies the COMPLETE payment flow including:
      // 1. Card tokenization via Helcim.js
      // 2. Payment processing via Helcim API
      // 3. Webhook delivery (via Hookdeck in CI)
      // 4. Webhook signature verification
      // 5. Balance update in database

      const billingPage = new BillingPage(billingSuccessPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();
      const initialBalance = await billingPage.waitForBalanceLoaded();
      const before = await readMoneyState(billingSuccessPage.request);

      const depositDollars = String(MIN_DEPOSIT_USD);

      await billingPage.openPaymentModal();
      await billingPage.enterAmount(depositDollars);

      // devdocs.helcim.com/docs/test-credit-card-numbers
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '100',
        cardHolderName: 'Test User',
        billingAddress: '123 Test Street',
        zip: '12345',
      });

      await billingPage.submitPayment();

      // For real Helcim: payment goes to "processing" state (awaiting webhook)
      // The UI should show processing indicator while polling for confirmation
      // Webhook flow: Helcim → Hookdeck → CI runner → signature verified → balance credited

      // Wait for payment to complete (either immediate mock or webhook-based real)
      // Real Helcim + Hookdeck webhook can take 10-30s (tokenize + API + webhook delivery + poll)
      try {
        await billingPage.expectPaymentSuccess(TIMEOUTS.WEBHOOK);
      } catch (error) {
        await testInfo.attach('diagnostic-report-full-payment', {
          body: JSON.stringify(
            {
              context: 'full payment flow',
              uiState: await billingPage.captureCurrentState(),
              apiResponses: billingPage.getDiagnosticReport(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      }

      await billingPage.goto();

      // The rendered poll waits out the webhook's own latency on the webhook
      // budget; the balance-delta assertion then compares served amounts on
      // the narrower assertion budget.
      await billingPage.waitForWebhookConfirmation(
        initialBalance,
        MIN_DEPOSIT_USD,
        TIMEOUTS.WEBHOOK
      );

      await expectBalanceDelta(billingSuccessPage.request, before, {
        purchased: allowedMinimumDeposit(),
      });

      await test.step('transaction history shows the payment', async () => {
        const txList = billingSuccessPage.getByTestId(TEST_IDS.transactionListContainer);
        await expect(txList).toBeVisible();

        const txRows = txList.getByTestId(TEST_IDS.transactionRow);
        await expect(txRows.first()).toBeVisible();

        const firstRow = txRows.first();
        // The credit as the row renders it, through the cent math the app
        // formats with: a prefix match on the dollar figure alone holds over
        // ten and a hundred times the amount.
        const renderedCredit = `+$${nanoUsdToDollarString(dollarsToNanoUsd(depositDollars))}`;
        await expect(firstRow).toContainText(renderedCredit);
      });

      await test.step('reopening Add Credits starts at the deposited amount', async () => {
        await billingPage.openPaymentModal();
        // The field writes dollars to the cent, from the deposit the form reads back.
        await expect(billingPage.amountInput).toHaveValue(
          nanoUsdToDollarString(allowedMinimumDeposit().toString())
        );
      });
    });

    test('handles declined card', async ({ authenticatedPage }, testInfo) => {
      const billingPage = new BillingPage(authenticatedPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

      // The wallet as the server holds it. A decline that still moved money is
      // invisible to the rendered figure — the balance query is never
      // invalidated on this path — so the assertion has to read the wallet.
      const before = await readMoneyState(authenticatedPage.request);

      // CVV 200 = decline (devdocs.helcim.com/docs/testing-declines-and-avs)
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '200',
        cardHolderName: 'Test User',
        billingAddress: '123 Test Street',
        zip: '12345',
      });

      await billingPage.submitPayment();

      try {
        await billingPage.expectPaymentError();
      } catch (error) {
        await testInfo.attach('diagnostic-report-declined-card', {
          body: JSON.stringify(
            {
              context: 'declined card',
              uiState: await billingPage.captureCurrentState(),
              apiResponses: billingPage.getDiagnosticReport(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      }

      // The decline is terminal before this runs, which is what a negative
      // needs: no amount of waiting can establish one.
      await expectNoWalletMovement(authenticatedPage.request, before);
    });

    test('accepts a genuinely signed Helcim webhook and credits the wallet', async ({
      billingSuccessPage2,
    }, testInfo) => {
      // This test ensures that:
      // 1. Real Helcim sends a properly signed webhook
      // 2. Our webhook signature validation correctly checks it
      // 3. If signature verification failed, balance would NOT update
      //
      // The fact that balance updates proves signature verification passed.

      const billingPage = new BillingPage(billingSuccessPage2);
      billingPage.enableDiagnostics();
      await billingPage.goto();
      const initialBalance = await billingPage.waitForBalanceLoaded();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '100',
        cardHolderName: 'Test User',
        billingAddress: '123 Test Street',
        zip: '12345',
      });
      await billingPage.submitPayment();

      try {
        await billingPage.expectPaymentSuccess(TIMEOUTS.WEBHOOK);
      } catch (error) {
        await testInfo.attach('diagnostic-report-webhook-signature', {
          body: JSON.stringify(
            {
              context: 'webhook signature validation',
              uiState: await billingPage.captureCurrentState(),
              apiResponses: billingPage.getDiagnosticReport(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      }

      await billingPage.goto();

      // If webhook signature verification failed, this would timeout
      // because the webhook credit processing would never be called
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, TIMEOUTS.WEBHOOK);

      // Balance updated = webhook was received AND signature was valid
      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBeGreaterThan(initialBalance);
    });
  });

  // Token-login payment also drives the real Helcim → Hookdeck webhook path; @webhook gates
  // it to the chromium runner in CI, replacing the former `SKIP_WEBHOOK_TESTS` in-body skip.
  test.describe('Token-Login Billing Portal', { tag: '@webhook' }, () => {
    test.setTimeout(TIMEOUTS.LONG);

    test('unauthenticated user completes payment via billing token', async ({
      billingTokenRequest,
      unauthenticatedPage,
    }) => {
      let billingToken = '';

      await test.step('generate billing login token', async () => {
        const response = await idempotentPost(billingTokenRequest, `${apiUrl}/billing/login-link`);
        await expectOkResponse(response, 'billing login-link');
        const { token } = (await response.json()) as { token: string };
        expect(token).toBeTruthy();
        billingToken = token;
      });

      await test.step('open billing portal with token', async () => {
        await unauthenticatedPage.goto(`/billing-portal?token=${billingToken}`, {
          waitUntil: 'domcontentloaded',
        });

        // The token exchange is async and nothing else stands between the
        // navigation and the portal: it hands back a path-scoped billing
        // credential of its own kind, which no account-hydration route admits,
        // so the portal renders on that call resolving. The web-first retrying
        // assertion below waits it out.
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.billingPortal)).toBeVisible({
          timeout: TIMEOUTS.APP_STABLE,
        });
      });

      await test.step('billing page renders without app shell', async () => {
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.balanceDisplay)).toBeVisible({
          timeout: TIMEOUTS.ASSERT,
        });
        await expect(
          unauthenticatedPage.getByRole('button', { name: 'Add Credits' })
        ).toBeVisible();

        await expect(unauthenticatedPage.getByTestId(TEST_IDS.accountButton)).not.toBeVisible();
      });

      const billingPage = new BillingPage(unauthenticatedPage);
      billingPage.enableDiagnostics();
      const initialBalance = await billingPage.waitForBalanceLoaded();

      await test.step('complete payment flow', async () => {
        await billingPage.openPaymentModal();
        await billingPage.enterAmount(String(MIN_DEPOSIT_USD));

        await billingPage.fillCardDetails({
          cardNumber: '4124939999999990',
          expiry: '01/28',
          cvv: '100',
          cardHolderName: 'Token User',
          billingAddress: '123 Test Street',
          zip: '12345',
        });

        await billingPage.submitPayment();
        await billingPage.expectPaymentSuccess(TIMEOUTS.WEBHOOK);
      });

      await test.step('the balance card offers the way back to the app', async () => {
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.balanceAdded)).toHaveText(
          `+$${nanoUsdToDollarString(allowedMinimumDeposit().toString())} added to your balance`
        );

        const returnToApp = unauthenticatedPage.getByTestId(TEST_IDS.returnToAppLink);
        await expect(returnToApp).toHaveAttribute('href', APP_RETURN_TO_BILLING_URL);
        // The way back carries no portal token.
        await expect(returnToApp).not.toHaveAttribute('href', /token/);
      });

      await test.step('balance updated after payment', async () => {
        // A token stays redeemable for its 60-second TTL, so the first one would still open
        // the portal; the reload mints its own.
        const freshResponse = await idempotentPost(
          billingTokenRequest,
          `${apiUrl}/billing/login-link`
        );
        await expectOkResponse(freshResponse, 'billing login-link');
        const { token: freshToken } = (await freshResponse.json()) as { token: string };

        await unauthenticatedPage.goto(`/billing-portal?token=${freshToken}`, {
          waitUntil: 'domcontentloaded',
        });
        await billingPage.waitForWebhookConfirmation(initialBalance, 5, TIMEOUTS.WEBHOOK);

        const newBalance = await billingPage.getBalance();
        expect(newBalance).toBe(initialBalance + 5);
      });

      // The credential the portal holds is scoped to the billing path and is
      // not a login session, so the app shell finds no authenticated principal.
      await test.step('the billing credential cannot access chat', async () => {
        // The free-preview shell renders the same for a visitor this route
        // answers and for one it refuses, so the read's own status is the only
        // place a credential that still reached the trial surface would show:
        // the route refuses every principal but `none`.
        const trialRemainingRead = unauthenticatedPage.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname.endsWith('/chat/trial/remaining')
        );
        await unauthenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
        const trialRemaining = await trialRemainingRead;

        await expect(unauthenticatedPage.getByText('Free preview')).toBeVisible({
          timeout: TIMEOUTS.APP_STABLE,
        });
        expect(trialRemaining.status()).toBe(200);
      });

      await test.step('a token that was never issued opens the expired state', async () => {
        // Deliberate: an issued token is replayable within its 60-second TTL, so the unknown
        // one is what reaches the refusal, and the server reports it on both channels.
        expectApiErrors(unauthenticatedPage, [/401 Unauthorized POST .*\/auth\/token-login/]);
        expectConsoleErrors(unauthenticatedPage, [
          /Failed to load resource: the server responded with a status of 401/,
        ]);

        await unauthenticatedPage.goto(`/billing-portal?token=${crypto.randomUUID()}`, {
          waitUntil: 'domcontentloaded',
        });

        const expired = unauthenticatedPage.getByTestId(TEST_IDS.billingPortalError);
        await expect(expired.getByRole('heading', { level: 1, name: 'Link expired' })).toBeVisible({
          timeout: TIMEOUTS.APP_STABLE,
        });
        await expect(expired.getByRole('link', { name: 'Log in' })).toHaveAttribute(
          'href',
          ROUTES.LOGIN
        );
      });
    });
  });
});

/**
 * The route the guard sits on. Both deposits reach it through the real payment
 * form: it takes a card token only tokenization hands out, so placing one
 * straight at the route would need a fabricated token the local mock alone
 * accepts, and would confine this proof to local dev.
 */
const CHARGE_ROUTE = '**/billing/payments';

/** The local payment mock's directive to hold a charge's confirming webhook until released. */
const HOLD_WEBHOOK_HEADER = 'x-mock-hold-payment-webhook';

/** devdocs.helcim.com/docs/test-credit-card-numbers */
const GUARD_CARD = {
  cardNumber: '4124939999999990',
  expiry: '01/28',
  cvv: '100',
  cardHolderName: 'Guard Payer',
  billingAddress: '9 Guard Lane',
  zip: '54321',
};

test.describe('Duplicate Deposit Guard', GUARD_MATRIX, () => {
  test(
    'refuses a second deposit while the first is still unresolved',
    { tag: '@webhook' },
    async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      await clearAuthRateLimits(request, []);

      const refusedPage = unauthenticatedPage;
      // Deliberate: the second deposit is the one the server must refuse, and
      // the browser reports that refusal on both channels. Narrow on purpose —
      // any other API failure on this page still fails the test, which is what
      // makes the refusal the only thing that went wrong here.
      expectApiErrors(refusedPage, [
        /409 Conflict POST .*\/billing\/payments/,
        /"code":"PAYMENT_IN_FLIGHT"/,
      ]);
      expectConsoleErrors(refusedPage, [
        /Failed to load resource: the server responded with a status of 409/,
      ]);

      // A payer minted per run, never a seeded persona: an unresolved deposit
      // blocks its payer for the whole guard window, so a shared persona would
      // carry one run's row into the next run's first deposit.
      const payer = {
        username: uniqueUsername('dep'),
        email: uniqueEmail('e2e-deposit-guard'),
        password: 'TestPassword123!',
      };
      await signUpViaUI(refusedPage, request, payer);
      await verifyEmailViaAPI(request, refusedPage, payer.email);
      // Keep-signed-in, and the second page of this context is why: without it
      // the sign-in marker is written to sessionStorage, which is per-tab, so a
      // second page boots with no marker — and that branch purges the device
      // key this page is holding rather than adopting it.
      await loginViaUI(refusedPage, {
        email: payer.email,
        password: payer.password,
        keepSignedIn: true,
      });

      // A second page of the same context, so one login and one payer — the
      // guard is per-payer, and a second context would authenticate twice for
      // nothing. What two pages buy is two PaymentForm instances: the form's
      // own re-entrancy ref refuses a second submit from one page, never from
      // two.
      //
      // It carries none of the harness's per-page guards, unlike every fixture
      // page. The context-level network allowlist and the recorded HAR still
      // cover it; what it lacks is console-error and API-≥400 promotion to
      // failures, and a page snapshot of its own.
      const earlierDepositPage = await refusedPage.context().newPage();

      // Resolved with `null` rather than nothing: `void` is reserved for
      // function return types here, so a signal-only promise carries a value.
      const refusedChargeCaptured = Promise.withResolvers<null>();
      const earlierDepositCommitted = Promise.withResolvers<null>();
      const refusalAnswered = Promise.withResolvers<null>();

      let earlierStatus = 0;
      let earlierBody: { status?: string; paymentId?: string } = {};
      let refusedStatus = 0;
      let refusedBody: unknown = null;

      // The overlap is these two interceptions and nothing else. The second
      // charge is captured before the earlier deposit is even submitted and
      // held until that deposit has answered, so the earlier row is committed
      // before the second charge reaches the guard. Where the local payment
      // mock takes the charge, the earlier one directs it to hold its
      // confirming webhook, so that row stays unresolved until this test
      // releases it after the refusal rather than when the mock's delivery
      // timer fires; against the real processor the directive is never read.
      // An ordering, not an interval: no branch here reads a clock.
      await refusedPage.route(CHARGE_ROUTE, async (route) => {
        refusedChargeCaptured.resolve(null);
        await earlierDepositCommitted.promise;
        const response = await route.fetch();
        refusedStatus = response.status();
        refusedBody = await response.json();
        refusalAnswered.resolve(null);
        await route.fulfill({ response });
      });

      // The earlier deposit's response is held open until the refusal has come
      // back, so the second submit is answered while the first charge is still
      // in flight as far as its own page is concerned.
      await earlierDepositPage.route(CHARGE_ROUTE, async (route) => {
        const response = await route.fetch({
          headers: { ...route.request().headers(), [HOLD_WEBHOOK_HEADER]: 'true' },
        });
        earlierStatus = response.status();
        earlierBody = (await response.json()) as { status?: string; paymentId?: string };
        earlierDepositCommitted.resolve(null);
        await refusalAnswered.promise;
        await route.fulfill({ response });
      });

      const earlierBilling = new BillingPage(earlierDepositPage);
      await earlierBilling.goto();
      const initialBalance = await earlierBilling.waitForBalanceLoaded();
      const before = await readMoneyState(earlierDepositPage.request);
      await earlierBilling.openPaymentModal();
      await earlierBilling.enterAmount(String(MIN_DEPOSIT_USD));
      await earlierBilling.fillCardDetails(GUARD_CARD);

      const refusedBilling = new BillingPage(refusedPage);
      await refusedBilling.goto();
      await refusedBilling.waitForBalanceLoaded();
      await refusedBilling.openPaymentModal();
      await refusedBilling.enterAmount(String(MIN_DEPOSIT_USD));
      await refusedBilling.fillCardDetails(GUARD_CARD);

      // Submitted first, forwarded last: the click tokenizes and posts, and the
      // post sits in the refused page's interception until the earlier deposit
      // lands.
      await refusedBilling.submitPayment();
      await refusedChargeCaptured.promise;

      await earlierBilling.submitPayment();

      // The card that says nothing was charged, and the one state that must
      // never offer a way to start another purchase. Budgeted like every other
      // payment assertion in this file, and it has to be: the refusal is
      // forwarded only once the earlier charge has answered, so this waits out
      // a whole charge round trip before the card can appear.
      await expect(refusedPage.getByRole('heading', { name: 'Purchase Not Started' })).toBeVisible({
        timeout: TIMEOUTS.WEBHOOK,
      });
      await expect(
        refusedPage.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
      ).toBeVisible();
      await expect(refusedBilling.tryAgainButton).toHaveCount(0);

      expect(earlierStatus).toBe(200);
      expect(earlierBody.status).toBe('awaiting_webhook');
      expect(refusedStatus).toBe(409);
      expect(refusedBody).toEqual({ code: ERROR_CODES.PAYMENT_IN_FLIGHT });

      // The held deposit resolves on its own webhook once released, so this
      // payer is left with no unresolved row. The wallet then moves by one
      // deposit and not two, which is the guard's effect rather than its error
      // code — an admitted second charge would credit the same amount again.
      const earlierPaymentId = earlierBody.paymentId;
      if (earlierPaymentId === undefined) {
        throw new Error('the earlier deposit answered without a paymentId to release');
      }
      const released = await withRequestRetry(earlierDepositPage.request).get(
        `${apiUrl}/billing/mock/release-webhook?paymentId=${earlierPaymentId}`
      );
      await expectOkResponse(released, 'deposit webhook release');
      await earlierBilling.expectPaymentSuccess();
      await earlierBilling.goto();
      await earlierBilling.waitForWebhookConfirmation(initialBalance, MIN_DEPOSIT_USD);
      await expectBalanceDelta(earlierDepositPage.request, before, {
        purchased: allowedMinimumDeposit(),
      });
    }
  );
});
