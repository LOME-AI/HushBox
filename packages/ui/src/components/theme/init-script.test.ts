import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { THEME_INIT_SCRIPT } from './init-script';

const STORAGE_KEY = 'themeMode';
const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/** Run the inline init script as if the browser parsed it from <head>. */
function runInitScript(): void {
  // Use new Function so the script executes against the test's globals (window/document/localStorage).
  // The script is a self-contained IIFE — it returns nothing.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- intentional: this is a test that must execute the inline init script source the same way <head> would parse it
  new Function(THEME_INIT_SCRIPT)();
}

/** Stub `window.matchMedia` to return the given prefers-color-scheme: dark value. */
function stubColorSchemeMediaQuery(matches: boolean): void {
  Object.defineProperty(globalThis.window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === COLOR_SCHEME_QUERY ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** Reset documentElement and localStorage between tests. */
function resetEnvironment(): void {
  document.documentElement.className = '';
  globalThis.window.localStorage.clear();
  stubColorSchemeMediaQuery(false);
}

describe('THEME_INIT_SCRIPT', () => {
  beforeEach(() => {
    resetEnvironment();
  });

  afterEach(() => {
    resetEnvironment();
    vi.restoreAllMocks();
  });

  describe('shape', () => {
    it('exports a non-empty string', () => {
      expect(typeof THEME_INIT_SCRIPT).toBe('string');
      expect(THEME_INIT_SCRIPT.length).toBeGreaterThan(0);
    });

    it('contains no ES module imports (must run before bundles load)', () => {
      expect(THEME_INIT_SCRIPT).not.toMatch(/\bimport\s+/);
      expect(THEME_INIT_SCRIPT).not.toMatch(/\bexport\s+/);
      expect(THEME_INIT_SCRIPT).not.toMatch(/\brequire\s*\(/);
    });

    it('references the canonical storage key', () => {
      expect(THEME_INIT_SCRIPT).toContain(STORAGE_KEY);
    });
  });

  describe('resolution', () => {
    it('applies dark when themeMode is explicitly dark on a light OS', () => {
      globalThis.window.localStorage.setItem(STORAGE_KEY, 'dark');
      stubColorSchemeMediaQuery(false);
      runInitScript();
      expect(isDark()).toBe(true);
    });

    it('does not apply dark when themeMode is explicitly light on a dark OS', () => {
      globalThis.window.localStorage.setItem(STORAGE_KEY, 'light');
      stubColorSchemeMediaQuery(true);
      runInitScript();
      expect(isDark()).toBe(false);
    });

    it('follows the OS dark preference when no themeMode is stored', () => {
      stubColorSchemeMediaQuery(true);
      runInitScript();
      expect(isDark()).toBe(true);
    });

    it('stays light when no themeMode is stored and the OS prefers light', () => {
      stubColorSchemeMediaQuery(false);
      runInitScript();
      expect(isDark()).toBe(false);
    });

    it('removes a dark class already on the element when the resolution is light', () => {
      document.documentElement.classList.add('dark');
      globalThis.window.localStorage.setItem(STORAGE_KEY, 'light');
      stubColorSchemeMediaQuery(true);
      runInitScript();
      expect(isDark()).toBe(false);
    });
  });

  describe('blocked browser APIs', () => {
    it('does not throw and stays light when storage access throws (e.g. private mode)', () => {
      const localStorage = globalThis.window.localStorage;
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = (): string => {
        throw new Error('SecurityError');
      };
      try {
        expect(() => {
          runInitScript();
        }).not.toThrow();
        expect(isDark()).toBe(false);
      } finally {
        localStorage.getItem = originalGetItem;
      }
    });

    it('does not throw when matchMedia throws (private mode / minimal envs)', () => {
      Object.defineProperty(globalThis.window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: () => {
          throw new Error('blocked');
        },
      });
      expect(() => {
        runInitScript();
      }).not.toThrow();
      expect(isDark()).toBe(false);
    });
  });
});
