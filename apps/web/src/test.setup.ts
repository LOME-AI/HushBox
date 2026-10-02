import '@testing-library/jest-dom/vitest';
import '@hushbox/shared/test-polyfills';
import { webcrypto } from 'node:crypto';

// Polyfill crypto.getRandomValues for Node.js test environment
// jsdom provides crypto but without getRandomValues - must override before each test
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
});

// Global mock for stability provider - provides a stable state by default
// Individual tests can override this via vi.mock() if they need different behavior
vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
  StabilityProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock localStorage for Zustand persist middleware
const localStorageMock: Storage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(() => null),
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});
