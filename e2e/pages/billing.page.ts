import { type Locator, type Page } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';

interface DiagnosticData {
  apiResponses: { url: string; status: number; body: string }[];
  consoleLogs: string[];
}

export class BillingPage {
  readonly page: Page;
  readonly balanceDisplay: Locator;
  readonly addCreditsButton: Locator;
  readonly transactionList: Locator;
  readonly paymentModal: Locator;
  readonly amountInput: Locator;
  readonly cardNumberInput: Locator;
  readonly expiryInput: Locator;
  readonly cvvInput: Locator;
  readonly cardHolderNameInput: Locator;
  readonly billingAddressInput: Locator;
  readonly zipInput: Locator;
  readonly purchaseButton: Locator;
  readonly simulateSuccessButton: Locator;
  readonly simulateFailureButton: Locator;
  readonly paymentSuccessCard: Locator;
  readonly paymentErrorCard: Locator;
  readonly closeButton: Locator;
  readonly tryAgainButton: Locator;
  readonly processingIndicator: Locator;

  private diagnostics: DiagnosticData = {
    apiResponses: [],
    consoleLogs: [],
  };

  constructor(page: Page) {
    this.page = page;
    this.balanceDisplay = page.getByTestId(TEST_IDS.balanceDisplay);
    this.addCreditsButton = page.getByRole('button', { name: 'Add Credits' });
    this.transactionList = page.getByTestId(TEST_IDS.transactionListContainer);
    this.paymentModal = page.getByTestId(TEST_IDS.paymentModal);
    this.amountInput = page.locator('#amount-input');
    this.cardNumberInput = page.locator('#cardNumber');
    this.expiryInput = page.locator('#cardExpiryDate');
    this.cvvInput = page.locator('#cardCVV');
    this.cardHolderNameInput = page.locator('#cardHolderName');
    this.billingAddressInput = page.locator('#cardHolderAddress');
    this.zipInput = page.locator('#cardHolderPostalCode');
    this.purchaseButton = page.getByRole('button', { name: 'Purchase' });
    this.simulateSuccessButton = page.getByTestId(TEST_IDS.simulateSuccessBtn);
    this.simulateFailureButton = page.getByTestId(TEST_IDS.simulateFailureBtn);
    this.paymentSuccessCard = page.getByText('Payment Successful');
    this.paymentErrorCard = page.getByText('Payment Failed');
    this.closeButton = this.paymentModal.getByRole('button', { name: 'Close' });
    this.tryAgainButton = page.getByRole('button', { name: 'Try Again' });
    this.processingIndicator = page.getByText('Processing payment...');
  }

  async goto(): Promise<void> {
    await this.page.goto('/billing', { waitUntil: 'domcontentloaded' });
  }

  async expectBalanceVisible(): Promise<void> {
    await expect(this.balanceDisplay).toBeVisible();
  }

  async getBalance(): Promise<number> {
    const balanceText = await this.balanceDisplay.textContent();
    const match = /\$?([\d.]+)/.exec(balanceText ?? '');
    return match ? Number.parseFloat(match[1] ?? '0') : 0;
  }

  async waitForBalanceLoaded(): Promise<number> {
    await this.balanceDisplay.waitFor({ state: 'visible', timeout: TIMEOUTS.ASSERT });
    await this.page.waitForFunction(
      (testId: string) => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        const text = el?.textContent ?? '';
        return /\$\d+\.\d+/.test(text);
      },
      TEST_IDS.balanceDisplay,
      { timeout: TIMEOUTS.ASSERT }
    );
    return this.getBalance();
  }

  async openPaymentModal(): Promise<void> {
    await this.addCreditsButton.click();
    await expect(this.paymentModal).toBeVisible();
  }

  async enterAmount(amount: string): Promise<void> {
    await this.amountInput.fill(amount);
  }

  async simulateSuccessfulPayment(amount = '10'): Promise<void> {
    await this.openPaymentModal();
    await this.enterAmount(amount);
    await this.simulateSuccessButton.click();
    await this.expectPaymentSuccess();
  }

  async simulateFailedPayment(amount = '10'): Promise<void> {
    await this.openPaymentModal();
    await this.enterAmount(amount);
    await this.simulateFailureButton.click();
    await expect(this.paymentErrorCard).toBeVisible({ timeout: TIMEOUTS.WEBHOOK });
  }

  async fillCardDetails(details: {
    cardNumber: string;
    expiry: string;
    cvv: string;
    cardHolderName: string;
    billingAddress: string;
    zip: string;
  }): Promise<void> {
    await this.cardNumberInput.fill(details.cardNumber);
    await this.expiryInput.fill(details.expiry);
    await this.cvvInput.fill(details.cvv);
    await this.cardHolderNameInput.fill(details.cardHolderName);
    await this.billingAddressInput.fill(details.billingAddress);
    await this.zipInput.fill(details.zip);
  }

  async submitPayment(): Promise<void> {
    await this.purchaseButton.click();
  }

  async expectPaymentSuccess(timeout: number = TIMEOUTS.WEBHOOK): Promise<void> {
    // Wait for "Payment Successful" text (CardTitle renders as div, not heading).
    // The real Helcim + Hookdeck webhook can take tens of seconds to arrive.
    await expect(this.paymentSuccessCard).toBeVisible({ timeout });
  }

  async expectPaymentError(): Promise<void> {
    // Wait for "Payment Failed" text (CardTitle renders as div, not heading).
    // Helcim's processing response can arrive well after the mutation resolves.
    await expect(this.paymentErrorCard).toBeVisible({ timeout: TIMEOUTS.WEBHOOK });
  }

  async closeSuccessAndReset(): Promise<void> {
    await this.closeButton.click();
    await expect(this.paymentModal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  async closeErrorAndRetry(): Promise<void> {
    await this.tryAgainButton.click();
    await expect(this.amountInput).toBeVisible();
  }

  /**
   * Wait for payment to be confirmed via webhook.
   * Polls the balance until it increases by the expected amount.
   * Used for real Helcim payments where webhook confirmation is async.
   *
   * Each poll reloads the page and re-reads the balance; `expect.poll`
   * retries on a falling assertion but propagates a thrown callback error
   * immediately, so the session-loss redirect fast-fails instead of burning
   * the full timeout budget.
   */
  async waitForWebhookConfirmation(
    initialBalance: number,
    expectedIncrease: number,
    timeout: number = TIMEOUTS.WEBHOOK
  ): Promise<void> {
    await expect
      .poll(
        async () => {
          await this.page.reload({ waitUntil: 'domcontentloaded' });

          // Detect session loss — fail fast instead of polling to timeout
          if (this.page.url().includes('/login')) {
            throw new Error(
              'Session lost — redirected to login during webhook confirmation polling'
            );
          }

          await this.page
            .locator('.animate-pulse')
            .first()
            .waitFor({ state: 'hidden', timeout: TIMEOUTS.ASSERT })
            .catch(() => {
              // Ignore — skeleton may not appear
            });
          await this.balanceDisplay.waitFor({ state: 'visible', timeout: TIMEOUTS.ASSERT });
          return this.getBalance();
        },
        { timeout }
      )
      .toBeGreaterThanOrEqual(initialBalance + expectedIncrease);
  }

  /**
   * Enable diagnostic logging for debugging test failures.
   * Captures API responses and console errors/warnings.
   * Call this at the start of a test to begin collecting data.
   */
  enableDiagnostics(): void {
    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/billing/') || url.includes('/webhooks/') || url.includes('helcim')) {
        try {
          const body = await response.text();
          this.diagnostics.apiResponses.push({
            url,
            status: response.status(),
            body: body.slice(0, 1000),
          });
        } catch {
          this.diagnostics.apiResponses.push({
            url,
            status: response.status(),
            body: '[unable to read body]',
          });
        }
      }
    });

    this.page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        this.diagnostics.consoleLogs.push(`[${type}] ${msg.text()}`);
      }
    });
  }

  /**
   * Capture the current UI state for debugging.
   * Shows which payment states are visible.
   */
  async captureCurrentState(): Promise<{
    processingVisible: boolean;
    successVisible: boolean;
    errorVisible: boolean;
    formVisible: boolean;
    scriptLoadingVisible: boolean;
    visibleText: string;
  }> {
    const [processingVisible, successVisible, errorVisible, formVisible, scriptLoadingVisible] =
      await Promise.all([
        this.processingIndicator.isVisible().catch(() => false),
        this.paymentSuccessCard.isVisible().catch(() => false),
        this.paymentErrorCard.isVisible().catch(() => false),
        this.cardNumberInput.isVisible().catch(() => false),
        this.page
          .getByTestId(TEST_IDS.helcimLoading)
          .isVisible()
          .catch(() => false),
      ]);

    const visibleText = await this.paymentModal.textContent().catch(() => '[modal not found]');

    return {
      processingVisible,
      successVisible,
      errorVisible,
      formVisible,
      scriptLoadingVisible,
      visibleText: (visibleText ?? '[no text content]').slice(0, 500),
    };
  }

  /**
   * Get the diagnostic report as a JSON string.
   * Contains all captured API responses and console logs.
   */
  getDiagnosticReport(): string {
    return JSON.stringify(this.diagnostics, null, 2);
  }
}
