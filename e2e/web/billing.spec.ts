import { test, expect } from '../fixtures.js';
import { BillingPage } from '../pages';

// Branch on CI env var (always set by GitHub Actions), not on credentials
const isCI = Boolean(process.env['CI']);

test.describe('Billing & Payments', () => {
  test.describe('Billing Page', () => {
    test('displays balance and opens payment modal', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.expectBalanceVisible();
      await expect(billingPage.addCreditsButton).toBeVisible();

      await billingPage.openPaymentModal();
      await expect(billingPage.amountInput).toBeVisible();
    });
  });

  test.describe('Payment Flow (Dev Mode)', () => {
    // Dev Mode tests use simulate buttons which are only visible in local dev (isLocalDev)
    // In CI, VITE_CI=true makes isLocalDev=false, so simulate buttons are hidden
    test.skip(isCI, 'Dev mode tests only run locally (simulate buttons hidden in CI)');

    test('simulates successful payment and updates balance', async ({ billingDevModePage }) => {
      const billingPage = new BillingPage(billingDevModePage);
      await billingPage.goto();

      const initialBalance = await billingPage.waitForBalanceLoaded();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('25');

      // Click simulate success
      await billingPage.simulateSuccessButton.click();

      // Wait for success heading to appear
      await billingPage.expectPaymentSuccess();

      // Close the modal
      await billingPage.closeSuccessAndReset();

      // Wait for balance to update (cache invalidation and refetch)
      await billingPage.page.waitForTimeout(1000);

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance + 25);
    });

    test('simulates failed payment and shows error', async ({ billingFailurePage }) => {
      const billingPage = new BillingPage(billingFailurePage);
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();

      await billingPage.simulateFailedPayment('10');

      // Balance should not change
      await billingPage.closeErrorAndRetry();
      await billingFailurePage.keyboard.press('Escape');
      await billingFailurePage.waitForTimeout(500);

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance);
    });

    test('validates minimum deposit amount', async ({ billingValidationPage }) => {
      const billingPage = new BillingPage(billingValidationPage);
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('2'); // Below $5 minimum

      // Purchase button should be disabled or show validation error
      const amountInput = billingPage.amountInput;
      await expect(amountInput).toHaveAttribute('aria-invalid', 'true');
    });
  });

  test.describe('Payment Flow (Full)', () => {
    // Full payment flow tests run both locally (with mocks) and in CI (with real Helcim sandbox)
    // Locally: Mock Helcim.js tokenizes, mock API processes, mock webhook delivers (1 sec)
    // CI: Real Helcim.js tokenizes, real API processes, real webhook via Hookdeck
    // Only run on chromium in CI - webhooks only delivered to one Hookdeck listener
    test.skip(
      () => !!process.env['SKIP_WEBHOOK_TESTS'],
      'Webhook tests only run on chromium runner'
    );

    // Increase timeout for real payment tests (webhook may take time)
    test.setTimeout(60_000);

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

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

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
      try {
        await billingPage.expectPaymentSuccess();
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

      // Navigate to billing page to check balance
      await billingPage.goto();

      // Poll for balance update (webhook may take a few seconds)
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, 30_000);

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance + 5);
    });

    test('handles declined card', async ({ authenticatedPage }, testInfo) => {
      const billingPage = new BillingPage(authenticatedPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

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
    });

    test('validates real Helcim webhook signature', async ({ billingSuccessPage2 }, testInfo) => {
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
        await billingPage.expectPaymentSuccess();
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
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, 30_000);

      // Balance updated = webhook was received AND signature was valid
      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBeGreaterThan(initialBalance);
    });
  });
});
