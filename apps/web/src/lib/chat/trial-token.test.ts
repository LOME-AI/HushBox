import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTrialToken, peekTrialToken, setTrialToken, TRIAL_TOKEN_KEY } from './trial-token.js';

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

  describe('peekTrialToken', () => {
    it('returns null when no token has been stored', () => {
      expect(peekTrialToken()).toBeNull();
    });

    it('leaves localStorage untouched when no token has been stored', () => {
      peekTrialToken();

      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).toBeNull();
    });

    it('returns the stored token when one exists', () => {
      localStorage.setItem(TRIAL_TOKEN_KEY, 'stored-test-token');

      expect(peekTrialToken()).toBe('stored-test-token');
    });
  });

  describe('setTrialToken', () => {
    it('stores the given token in localStorage', () => {
      setTrialToken('session-from-server');

      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).toBe('session-from-server');
    });

    it('overwrites a token minted earlier', () => {
      const minted = getTrialToken();

      setTrialToken('session-from-server');

      expect(localStorage.getItem(TRIAL_TOKEN_KEY)).not.toBe(minted);
      expect(peekTrialToken()).toBe('session-from-server');
    });
  });

  describe('TRIAL_TOKEN_KEY', () => {
    it('exports the localStorage key constant', () => {
      expect(TRIAL_TOKEN_KEY).toBe('hushbox-trial-token');
    });
  });
});
