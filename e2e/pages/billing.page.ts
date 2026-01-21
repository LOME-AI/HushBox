import { expect, type Locator, type Page } from '@playwright/test';

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
    this.balanceDisplay = page.getByTestId('balance-display');
    this.addCreditsButton = page.getByRole('button', { name: 'Add Credits' });
    this.transactionList = page.getByTestId('transaction-list-container');
    this.paymentModal = page.getByTestId('payment-modal');
    this.amountInput = page.locator('#amount-input');
    this.cardNumberInput = page.locator('#cardNumber');
    this.expiryInput = page.locator('#cardExpiryDate');
    this.cvvInput = page.locator('#cardCVV');
    this.cardHolderNameInput = page.locator('#cardHolderName');
    this.billingAddressInput = page.locator('#cardHolderAddress');
    this.zipInput = page.locator('#cardHolderPostalCode');
    this.purchaseButton = page.getByRole('button', { name: 'Purchase' });
    this.simulateSuccessButton = page.getByTestId('simulate-success-btn');
    this.simulateFailureButton = page.getByTestId('simulate-failure-btn');
    this.paymentSuccessCard = page.getByText('Payment Successful');
    this.paymentErrorCard = page.getByText('Payment Failed');
    this.closeButton = page.getByRole('button', { name: 'Close' });
    this.tryAgainButton = page.getByRole('button', { name: 'Try Again' });
    this.processingIndicator = page.getByText('Processing payment...');
  }

  async goto(): Promise<void> {
    await this.page.goto('/billing');
  }

  async expectBalanceVisible(): Promise<void> {
    await expect(this.balanceDisplay).toBeVisible();
  }

  async getBalance(): Promise<number> {
    const balanceText = await this.balanceDisplay.textContent();
    const match = /\$?([\d.]+)/.exec(balanceText ?? '');
    return match ? parseFloat(match[1] ?? '0') : 0;
  }

  async waitForBalanceLoaded(): Promise<number> {
    await this.balanceDisplay.waitFor({ state: 'visible', timeout: 10000 });
    await this.page.waitForFunction(
      (testId: string) => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        const text = el?.textContent ?? '';
        return /\$\d+\.\d+/.test(text);
      },
      'balance-display',
      { timeout: 10000 }
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
    await expect(this.paymentErrorCard).toBeVisible({ timeout: 15000 });
  }

  async fillCardDetails(
    cardNumber: string,
    expiry: string,
    cvv: string,
    cardHolderName: string,
    billingAddress: string,
    zip: string
  ): Promise<void> {
    await this.cardNumberInput.fill(cardNumber);
    await this.expiryInput.fill(expiry);
    await this.cvvInput.fill(cvv);
    await this.cardHolderNameInput.fill(cardHolderName);
    await this.billingAddressInput.fill(billingAddress);
    await this.zipInput.fill(zip);
  }

  async submitPayment(): Promise<void> {
    await this.purchaseButton.click();
  }

  async expectPaymentSuccess(): Promise<void> {
    // Wait for "Payment Successful" text (CardTitle renders as div, not heading)
    await expect(this.paymentSuccessCard).toBeVisible({ timeout: 30000 });
  }

  async expectPaymentError(): Promise<void> {
    // Wait for "Payment Failed" text (CardTitle renders as div, not heading)
    await expect(this.paymentErrorCard).toBeVisible({ timeout: 15000 });
  }

  async closeSuccessAndReset(): Promise<void> {
    await this.closeButton.click();
    await expect(this.paymentModal).not.toBeVisible({ timeout: 5000 });
  }

  async closeErrorAndRetry(): Promise<void> {
    await this.tryAgainButton.click();
    await expect(this.amountInput).toBeVisible();
  }

  /**
   * Wait for payment to be confirmed via webhook.
   * Polls the balance until it increases by the expected amount.
   * Used for real Helcim payments where webhook confirmation is async.
   */
  async waitForWebhookConfirmation(
    initialBalance: number,
    expectedIncrease: number,
    timeout = 30000
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startTime < timeout) {
      await this.page.reload({ waitUntil: 'networkidle' });
      await this.balanceDisplay.waitFor({ state: 'visible', timeout: 5000 });
      const currentBalance = await this.getBalance();

      if (currentBalance >= initialBalance + expectedIncrease) {
        return;
      }

      await this.page.waitForTimeout(pollInterval);
    }

    throw new Error(
      `Payment not confirmed within ${String(timeout)}ms. Expected balance increase of $${String(expectedIncrease)}`
    );
  }

  /**
   * Enable diagnostic logging for debugging test failures.
   * Captures API responses and console errors/warnings.
   * Call this at the start of a test to begin collecting data.
   */
  enableDiagnostics(): void {
    // Capture API responses for billing/webhook endpoints
    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/billing/') || url.includes('/webhooks/') || url.includes('helcim')) {
        try {
          const body = await response.text();
          this.diagnostics.apiResponses.push({
            url,
            status: response.status(),
            body: body.substring(0, 1000),
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

    // Capture console errors/warnings from the browser
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
          .getByTestId('helcim-loading')
          .isVisible()
          .catch(() => false),
      ]);

    const visibleText = await this.paymentModal.innerText().catch(() => '[modal not found]');

    return {
      processingVisible,
      successVisible,
      errorVisible,
      formVisible,
      scriptLoadingVisible,
      visibleText: visibleText.substring(0, 500),
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
