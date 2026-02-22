import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTrialToken, clearTrialToken, TRIAL_TOKEN_KEY } from './trial-token.js';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Required for localStorage mock
      delete store[key];
    },
    clear: (): void => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

describe('trial-token', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe('getTrialToken', () => {
    it('creates a new token when none exists', () => {
      const token = getTrialToken();

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('stores the token in localStorage', () => {
      const token = getTrialToken();

      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).toBe(token);
    });

    it('returns the same token on subsequent calls', () => {
      const token1 = getTrialToken();
      const token2 = getTrialToken();

      expect(token1).toBe(token2);
    });

    it('returns existing token from localStorage', () => {
      const existingToken = 'existing-test-token';
      localStorage.setItem(TRIAL_TOKEN_KEY, existingToken);

      const token = getTrialToken();

      expect(token).toBe(existingToken);
    });

    it('generates a UUID-format token', () => {
      const token = getTrialToken();

      // UUID format: 8-4-4-4-12 hex characters
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(token).toMatch(uuidRegex);
    });
  });

  describe('clearTrialToken', () => {
    it('removes the token from localStorage', () => {
      getTrialToken(); // Create a token first
      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).not.toBeNull();

      clearTrialToken();

      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    });

    it('does nothing if no token exists', () => {
      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();

      clearTrialToken(); // Should not throw

      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    });
  });

  describe('TRIAL_TOKEN_KEY', () => {
    it('exports the localStorage key constant', () => {
      expect(TRIAL_TOKEN_KEY).toBe('hushbox-trial-token');
    });
  });
});
