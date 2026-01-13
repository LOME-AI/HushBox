import { test, expect } from '../fixtures.js';
import { BillingPage } from '../pages';

// Branch on CI env var (always set by GitHub Actions), not on credentials
const isCI = Boolean(process.env['CI']);

test.describe('Billing & Payments', () => {
  test.describe('Billing Page', () => {
    test('displays balance and add credits button', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.expectBalanceVisible();
      await expect(billingPage.addCreditsButton).toBeVisible();
    });

    test('opens payment modal when clicking Add Credits', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await expect(billingPage.amountInput).toBeVisible();
    });
  });

  test.describe('Payment Flow (Dev Mode)', () => {
    // Dev Mode tests use simulate buttons which are only visible in local dev (isLocalDev)
    // In CI, VITE_CI=true makes isLocalDev=false, so simulate buttons are hidden
    test.skip(isCI, 'Dev mode tests only run locally (simulate buttons hidden in CI)');

    test('simulates successful payment and updates balance', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('25');

      // Click simulate success
      await billingPage.simulateSuccessButton.click();

      // Wait for success heading to appear
      await billingPage.expectPaymentSuccess();

      // Close the modal
      await billingPage.closeSuccessAndReset();

      // Reload page to ensure fresh balance data
      await billingPage.goto();

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBeGreaterThan(initialBalance);
      expect(newBalance).toBeCloseTo(initialBalance + 25, 1);
    });

    test('simulates failed payment and shows error', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();

      await billingPage.simulateFailedPayment('10');

      // Balance should not change
      await billingPage.closeErrorAndRetry();
      await authenticatedPage.keyboard.press('Escape');
      await authenticatedPage.waitForTimeout(500);

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance);
    });

    test('validates minimum deposit amount', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('2'); // Below $5 minimum

      // Purchase button should be disabled or show validation error
      const amountInput = billingPage.amountInput;
      await expect(amountInput).toHaveAttribute('aria-invalid', 'true');
    });
  });

  test.describe('Payment Flow (Helcim Sandbox)', () => {
    // Only run in CI where real Helcim sandbox credentials are available
    // Local dev uses simulate buttons instead
    test.skip(!isCI, 'Helcim sandbox tests only run in CI');

    // Increase timeout for real payment tests (webhook may take time)
    test.setTimeout(60000);

    test('completes full payment flow: card → API → webhook → balance', async ({
      authenticatedPage,
    }) => {
      // This test verifies the COMPLETE payment flow including:
      // 1. Card tokenization via Helcim.js
      // 2. Payment processing via Helcim API
      // 3. Webhook delivery (via Hookdeck in CI)
      // 4. Webhook signature verification
      // 5. Balance update in database

      const billingPage = new BillingPage(authenticatedPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

      // Use Helcim test card numbers from devdocs.helcim.com
      // Visa: 4030000010001234 - Approved
      await billingPage.fillCardDetails(
        '4030000010001234',
        '12/30',
        '100',
        'Test User',
        '123 Test Street',
        '12345'
      );

      await billingPage.submitPayment();

      // For real Helcim: payment goes to "processing" state (awaiting webhook)
      // The UI should show processing indicator while polling for confirmation
      // Webhook flow: Helcim → Hookdeck → CI runner → signature verified → balance credited

      // Wait for payment to complete (either immediate mock or webhook-based real)
      try {
        await billingPage.expectPaymentSuccess();
      } catch (error) {
        console.log('\n=== E2E DIAGNOSTIC REPORT (full payment flow) ===');
        console.log('\nUI State:');
        console.log(JSON.stringify(await billingPage.captureCurrentState(), null, 2));
        console.log('\nAPI Responses & Console Logs:');
        console.log(billingPage.getDiagnosticReport());
        throw error;
      }

      // Navigate to billing page to check balance
      await billingPage.goto();

      // Poll for balance update (webhook may take a few seconds)
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, 30000);

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBeCloseTo(initialBalance + 5, 1);
    });

    test('handles declined card', async ({ authenticatedPage }) => {
      const billingPage = new BillingPage(authenticatedPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

      // Use Helcim test card that gets declined
      // CVV 209 = "Do Not Honor" decline
      await billingPage.fillCardDetails(
        '4030000010001234',
        '12/30',
        '209',
        'Test User',
        '123 Test Street',
        '12345'
      );

      await billingPage.submitPayment();

      try {
        await billingPage.expectPaymentError();
      } catch (error) {
        console.log('\n=== E2E DIAGNOSTIC REPORT (declined card) ===');
        console.log('\nUI State:');
        console.log(JSON.stringify(await billingPage.captureCurrentState(), null, 2));
        console.log('\nAPI Responses & Console Logs:');
        console.log(billingPage.getDiagnosticReport());
        throw error;
      }
    });

    test('verifies webhook signature is validated (real Helcim signature)', async ({
      authenticatedPage,
    }) => {
      // This test ensures that:
      // 1. Real Helcim sends a properly signed webhook
      // 2. Our verifyWebhookSignatureAsync correctly validates it
      // 3. If signature verification failed, balance would NOT update
      //
      // The fact that balance updates proves signature verification passed.

      const billingPage = new BillingPage(authenticatedPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');
      await billingPage.fillCardDetails(
        '4030000010001234',
        '12/30',
        '100',
        'Test User',
        '123 Test Street',
        '12345'
      );
      await billingPage.submitPayment();

      try {
        await billingPage.expectPaymentSuccess();
      } catch (error) {
        console.log('\n=== E2E DIAGNOSTIC REPORT (webhook signature) ===');
        console.log('\nUI State:');
        console.log(JSON.stringify(await billingPage.captureCurrentState(), null, 2));
        console.log('\nAPI Responses & Console Logs:');
        console.log(billingPage.getDiagnosticReport());
        throw error;
      }

      await billingPage.goto();

      // If webhook signature verification failed, this would timeout
      // because processWebhookCredit would never be called
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, 30000);

      // Balance updated = webhook was received AND signature was valid
      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBeGreaterThan(initialBalance);
    });
  });
});
