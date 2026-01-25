import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockHelcim, uninstallMockHelcim, MOCK_TEST_CARDS } from './helcim-mock.js';

function getElement(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) {
    throw new Error(`Element not found: ${selector}`);
  }
  return el;
}

describe('helcim-mock', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="helcimForm">
        <input type="hidden" id="cardNumber" value="" />
        <input type="hidden" id="cardCVV" value="" />
        <div id="helcimResults">
          <input type="hidden" id="response" value="" />
          <input type="hidden" id="responseMessage" value="" />
          <input type="hidden" id="cardToken" value="" />
          <input type="hidden" id="cardType" value="" />
          <input type="hidden" id="cardF4L4" value="" />
          <input type="hidden" id="customerCode" value="" />
        </div>
      </form>
    `;
  });

  afterEach(() => {
    uninstallMockHelcim();
    document.body.innerHTML = '';
  });

  describe('installMockHelcim', () => {
    it('sets globalThis.helcimProcess', () => {
      expect(globalThis.helcimProcess).toBeUndefined();
      installMockHelcim();
      expect(globalThis.helcimProcess).toBeDefined();
    });
  });

  describe('uninstallMockHelcim', () => {
    it('removes globalThis.helcimProcess', () => {
      installMockHelcim();
      expect(globalThis.helcimProcess).toBeDefined();
      uninstallMockHelcim();
      expect(globalThis.helcimProcess).toBeUndefined();
    });
  });

  describe('mockHelcimProcess', () => {
    it('populates success response for valid test card', () => {
      installMockHelcim();

      const cardNumberEl = getElement('#cardNumber') as HTMLInputElement;
      const cardCvvEl = getElement('#cardCVV') as HTMLInputElement;
      cardNumberEl.value = MOCK_TEST_CARDS.SUCCESS.number;
      cardCvvEl.value = MOCK_TEST_CARDS.SUCCESS.cvv;

      expect(globalThis.helcimProcess).toBeDefined();
      globalThis.helcimProcess?.();

      const responseEl = getElement('#response') as HTMLInputElement;
      const cardTokenEl = getElement('#cardToken') as HTMLInputElement;
      const customerCodeEl = getElement('#customerCode') as HTMLInputElement;
      const cardTypeEl = getElement('#cardType') as HTMLInputElement;
      const cardF4L4El = getElement('#cardF4L4') as HTMLInputElement;

      expect(responseEl.value).toBe('1');
      expect(cardTokenEl.value).toMatch(/^mock-token-/);
      expect(customerCodeEl.value).toMatch(/^mock-customer-/);
      expect(cardTypeEl.value).toBe('Visa');
      expect(cardF4L4El.value).toContain('9990');
    });

    it('populates failure response for decline CVV', () => {
      installMockHelcim();

      const cardNumberEl = getElement('#cardNumber') as HTMLInputElement;
      const cardCvvEl = getElement('#cardCVV') as HTMLInputElement;
      cardNumberEl.value = MOCK_TEST_CARDS.SUCCESS.number;
      cardCvvEl.value = MOCK_TEST_CARDS.DECLINE.cvv;

      expect(globalThis.helcimProcess).toBeDefined();
      globalThis.helcimProcess?.();

      const responseEl = getElement('#response') as HTMLInputElement;
      const responseMessageEl = getElement('#responseMessage') as HTMLInputElement;

      expect(responseEl.value).toBe('0');
      expect(responseMessageEl.value).toBe('Card declined');
    });

    it('populates failure response for missing card number', () => {
      installMockHelcim();

      expect(globalThis.helcimProcess).toBeDefined();
      globalThis.helcimProcess?.();

      const responseEl = getElement('#response') as HTMLInputElement;
      const responseMessageEl = getElement('#responseMessage') as HTMLInputElement;

      expect(responseEl.value).toBe('0');
      expect(responseMessageEl.value).toBe('Card number required');
    });
  });

  describe('MOCK_TEST_CARDS', () => {
    it('has SUCCESS card with valid number', () => {
      expect(MOCK_TEST_CARDS.SUCCESS.number).toBe('4111111111111111');
      expect(MOCK_TEST_CARDS.SUCCESS.cvv).toBe('123');
    });

    it('has DECLINE card with CVV that triggers decline', () => {
      expect(MOCK_TEST_CARDS.DECLINE.cvv).toBe('200');
    });
  });
});
