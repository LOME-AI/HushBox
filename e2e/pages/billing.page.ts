import { expect, type Locator, type Page } from '@playwright/test';

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
  readonly zipInput: Locator;
  readonly purchaseButton: Locator;
  readonly simulateSuccessButton: Locator;
  readonly simulateFailureButton: Locator;
  readonly paymentSuccessCard: Locator;
  readonly paymentErrorCard: Locator;
  readonly makeAnotherDepositButton: Locator;
  readonly tryAgainButton: Locator;
  readonly processingIndicator: Locator;

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
    this.zipInput = page.locator('#cardHolderPostalCode');
    this.purchaseButton = page.getByRole('button', { name: 'Purchase' });
    this.simulateSuccessButton = page.getByTestId('simulate-success-btn');
    this.simulateFailureButton = page.getByTestId('simulate-failure-btn');
    this.paymentSuccessCard = page.getByText('Payment Successful');
    this.paymentErrorCard = page.getByText('Payment Failed');
    this.makeAnotherDepositButton = page.getByRole('button', { name: 'Make Another Deposit' });
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
    zip: string
  ): Promise<void> {
    await this.cardNumberInput.fill(cardNumber);
    await this.expiryInput.fill(expiry);
    await this.cvvInput.fill(cvv);
    await this.zipInput.fill(zip);
  }

  async submitPayment(): Promise<void> {
    await this.purchaseButton.click();
  }

  async expectPaymentSuccess(): Promise<void> {
    // Wait for "Payment Successful" heading or text
    const successIndicator = this.page.getByRole('heading', { name: 'Payment Successful' });
    await expect(successIndicator).toBeVisible({ timeout: 30000 });
  }

  async expectPaymentError(): Promise<void> {
    // Wait for "Payment Failed" heading
    const errorIndicator = this.page.getByRole('heading', { name: 'Payment Failed' });
    await expect(errorIndicator).toBeVisible({ timeout: 15000 });
  }

  async closeSuccessAndReset(): Promise<void> {
    await this.makeAnotherDepositButton.click();
    await expect(this.amountInput).toBeVisible();
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
      await this.page.reload();
      const currentBalance = await this.getBalance();

      if (currentBalance >= initialBalance + expectedIncrease - 0.01) {
        return;
      }

      await this.page.waitForTimeout(pollInterval);
    }

    throw new Error(
      `Payment not confirmed within ${String(timeout)}ms. Expected balance increase of $${String(expectedIncrease)}`
    );
  }
}
