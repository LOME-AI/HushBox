import '@testing-library/jest-dom/vitest';
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

// ResizeObserver polyfill for Radix UI Tooltip/Popover components
class ResizeObserverMock {
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}
globalThis.ResizeObserver = ResizeObserverMock;

// Polyfills for Radix UI components (Select, etc.)
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = function (): boolean {
    return false;
  };
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = function (): void {
    /* noop */
  };
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = function (): void {
    /* noop */
  };
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function (): void {
    /* noop */
  };
}

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

// Polyfill for matchMedia
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: (): void => {
      /* noop */
    },
    removeListener: (): void => {
      /* noop */
    },
    addEventListener: (): void => {
      /* noop */
    },
    removeEventListener: (): void => {
      /* noop */
    },
    dispatchEvent: (): boolean => false,
  }),
});
