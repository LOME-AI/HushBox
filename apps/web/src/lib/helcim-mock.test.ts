import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMockHelcim, uninstallMockHelcim, MOCK_TEST_CARDS } from './helcim-mock.js';

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
    it('sets window.helcimProcess', () => {
      expect(window.helcimProcess).toBeUndefined();
      installMockHelcim();
      expect(window.helcimProcess).toBeDefined();
    });
  });

  describe('uninstallMockHelcim', () => {
    it('removes window.helcimProcess', () => {
      installMockHelcim();
      expect(window.helcimProcess).toBeDefined();
      uninstallMockHelcim();
      expect(window.helcimProcess).toBeUndefined();
    });
  });

  describe('mockHelcimProcess', () => {
    it('populates success response for valid test card', () => {
      installMockHelcim();

      const cardNumberEl = document.getElementById('cardNumber') as HTMLInputElement;
      const cardCvvEl = document.getElementById('cardCVV') as HTMLInputElement;
      cardNumberEl.value = MOCK_TEST_CARDS.SUCCESS.number;
      cardCvvEl.value = MOCK_TEST_CARDS.SUCCESS.cvv;

      expect(window.helcimProcess).toBeDefined();
      window.helcimProcess?.();

      const responseEl = document.getElementById('response') as HTMLInputElement;
      const cardTokenEl = document.getElementById('cardToken') as HTMLInputElement;
      const customerCodeEl = document.getElementById('customerCode') as HTMLInputElement;
      const cardTypeEl = document.getElementById('cardType') as HTMLInputElement;
      const cardF4L4El = document.getElementById('cardF4L4') as HTMLInputElement;

      expect(responseEl.value).toBe('1');
      expect(cardTokenEl.value).toMatch(/^mock-token-/);
      expect(customerCodeEl.value).toMatch(/^mock-customer-/);
      expect(cardTypeEl.value).toBe('Visa');
      expect(cardF4L4El.value).toContain('9990');
    });

    it('populates failure response for decline CVV', () => {
      installMockHelcim();

      const cardNumberEl = document.getElementById('cardNumber') as HTMLInputElement;
      const cardCvvEl = document.getElementById('cardCVV') as HTMLInputElement;
      cardNumberEl.value = MOCK_TEST_CARDS.SUCCESS.number;
      cardCvvEl.value = MOCK_TEST_CARDS.DECLINE.cvv;

      expect(window.helcimProcess).toBeDefined();
      window.helcimProcess?.();

      const responseEl = document.getElementById('response') as HTMLInputElement;
      const responseMessageEl = document.getElementById('responseMessage') as HTMLInputElement;

      expect(responseEl.value).toBe('0');
      expect(responseMessageEl.value).toBe('Card declined');
    });

    it('populates failure response for missing card number', () => {
      installMockHelcim();

      expect(window.helcimProcess).toBeDefined();
      window.helcimProcess?.();

      const responseEl = document.getElementById('response') as HTMLInputElement;
      const responseMessageEl = document.getElementById('responseMessage') as HTMLInputElement;

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
