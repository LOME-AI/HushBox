import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadHelcimScript,
  resetHelcimLoader,
  isHelcimScriptLoaded,
  readHelcimResult,
} from './helcim-loader';

describe('helcim-loader', () => {
  beforeEach(() => {
    resetHelcimLoader();
    // Clear any appended scripts
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadHelcimScript', () => {
    it('creates a script element with correct src', async () => {
      const createElementSpy = vi.spyOn(document, 'createElement');

      const promise = loadHelcimScript();

      // Find the script element that was created
      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.src).toBe('https://secure.myhelcim.com/js/version2.js');
      expect(scripts[0]?.async).toBe(true);

      // Simulate script load
      scripts[0]?.dispatchEvent(new Event('load'));
      await promise;

      expect(createElementSpy).toHaveBeenCalledWith('script');
    });

    it('resolves when script loads successfully', async () => {
      const promise = loadHelcimScript();

      // Find and trigger load event
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects when script fails to load', async () => {
      const promise = loadHelcimScript();

      // Find and trigger error event
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('error'));

      await expect(promise).rejects.toThrow('Failed to load Helcim script');
    });

    it('returns same promise when called multiple times before load', async () => {
      const promise1 = loadHelcimScript();
      const promise2 = loadHelcimScript();

      expect(promise1).toBe(promise2);

      // Only one script should be created
      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(1);

      // Complete the load
      scripts[0]?.dispatchEvent(new Event('load'));
      await promise1;
    });

    it('returns immediately if already loaded', async () => {
      // First load
      const promise1 = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise1;

      // Second call should resolve immediately
      const promise2 = loadHelcimScript();
      await expect(promise2).resolves.toBeUndefined();

      // Still only one script
      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(1);
    });

    it('allows retry after error', async () => {
      // First attempt fails
      const promise1 = loadHelcimScript();
      let script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('error'));

      await expect(promise1).rejects.toThrow();

      // Reset head for second attempt
      document.head.innerHTML = '';

      // Second attempt should create new script
      const promise2 = loadHelcimScript();
      script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));

      await expect(promise2).resolves.toBeUndefined();
    });
  });

  describe('isHelcimScriptLoaded', () => {
    it('returns false initially', () => {
      expect(isHelcimScriptLoaded()).toBe(false);
    });

    it('returns true after script loads', async () => {
      const promise = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise;

      expect(isHelcimScriptLoaded()).toBe(true);
    });

    it('returns false after reset', async () => {
      const promise = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise;

      resetHelcimLoader();

      expect(isHelcimScriptLoaded()).toBe(false);
    });
  });

  describe('resetHelcimLoader', () => {
    it('resets loaded state', async () => {
      const promise = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise;

      expect(isHelcimScriptLoaded()).toBe(true);

      resetHelcimLoader();

      expect(isHelcimScriptLoaded()).toBe(false);
    });
  });

  describe('readHelcimResult', () => {
    beforeEach(() => {
      // Clean up any existing elements
      document.body.innerHTML = '';
    });

    it('returns success result when response is 1', () => {
      // Create mock DOM elements that Helcim populates
      createMockResultElements({
        response: '1',
        responseMessage: '',
        cardToken: 'token-123',
        cardType: 'Visa',
        cardF4L4: '12349999',
      });

      const result = readHelcimResult();

      expect(result.success).toBe(true);
      expect(result.cardToken).toBe('token-123');
      expect(result.cardType).toBe('Visa');
      expect(result.cardLastFour).toBe('9999');
    });

    it('returns failure result when response is not 1', () => {
      createMockResultElements({
        response: '0',
        responseMessage: 'Card declined',
        cardToken: '',
        cardType: '',
        cardF4L4: '',
      });

      const result = readHelcimResult();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card declined');
    });

    it('returns default error message when responseMessage is empty', () => {
      createMockResultElements({
        response: '0',
        responseMessage: '',
        cardToken: '',
        cardType: '',
        cardF4L4: '',
      });

      const result = readHelcimResult();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card tokenization failed');
    });

    it('handles missing DOM elements gracefully', () => {
      // No elements created
      const result = readHelcimResult();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card tokenization failed');
    });

    it('extracts last 4 digits from cardF4L4', () => {
      createMockResultElements({
        response: '1',
        responseMessage: '',
        cardToken: 'token-456',
        cardType: 'MasterCard',
        cardF4L4: '12341234', // First 4 and last 4
      });

      const result = readHelcimResult();

      expect(result.cardLastFour).toBe('1234');
    });
  });
});

/**
 * Helper to create mock input elements that Helcim.js populates
 */
function createMockResultElements(values: {
  response: string;
  responseMessage: string;
  cardToken: string;
  cardType: string;
  cardF4L4: string;
}): void {
  const elements = [
    { id: 'response', value: values.response },
    { id: 'responseMessage', value: values.responseMessage },
    { id: 'cardToken', value: values.cardToken },
    { id: 'cardType', value: values.cardType },
    { id: 'cardF4L4', value: values.cardF4L4 },
  ];

  for (const { id, value } of elements) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.id = id;
    input.value = value;
    document.body.appendChild(input);
  }
}
