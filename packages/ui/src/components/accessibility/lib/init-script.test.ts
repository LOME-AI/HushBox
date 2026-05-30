import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import type { AccessibilityPreferences } from '@hushbox/shared';
import { A11Y_INIT_SCRIPT } from './init-script';

const STORAGE_KEY = 'hushbox.a11y.v1';

/** Run the inline init script as if the browser parsed it from <head>. */
function runInitScript(): void {
  // Use new Function so the script executes against the test's globals (window/document/localStorage).
  // The script is a self-contained IIFE — it returns nothing.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- intentional: this is a test that must execute the inline init script source the same way <head> would parse it
  new Function(A11Y_INIT_SCRIPT)();
}

/** Persist a partial set of accessibility preferences in the same shape Zustand persist uses. */
function setStoredPrefs(overrides: Partial<AccessibilityPreferences> = {}): void {
  globalThis.window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ...overrides },
      version: 0,
    })
  );
}

/** Snapshot the documentElement classList so we can compare a11y-* classes. */
function a11yClasses(): string[] {
  return [...document.documentElement.classList]
    .filter((c) => c.startsWith('a11y-'))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Stub `window.matchMedia` to return the given prefers-reduced-motion value. */
function stubReducedMotionMediaQuery(matches: boolean): void {
  Object.defineProperty(globalThis.window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
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

/** Reset documentElement, head, and localStorage between tests. */
function resetEnvironment(): void {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.head.innerHTML = '';
  globalThis.window.localStorage.clear();
  stubReducedMotionMediaQuery(false);
}

describe('A11Y_INIT_SCRIPT', () => {
  beforeEach(() => {
    resetEnvironment();
  });

  afterEach(() => {
    resetEnvironment();
    vi.restoreAllMocks();
  });

  describe('shape', () => {
    it('exports a non-empty string', () => {
      expect(typeof A11Y_INIT_SCRIPT).toBe('string');
      expect(A11Y_INIT_SCRIPT.length).toBeGreaterThan(0);
    });

    it('contains no ES module imports (must run before bundles load)', () => {
      expect(A11Y_INIT_SCRIPT).not.toMatch(/\bimport\s+/);
      expect(A11Y_INIT_SCRIPT).not.toMatch(/\bexport\s+/);
      expect(A11Y_INIT_SCRIPT).not.toMatch(/\brequire\s*\(/);
    });

    it('references the canonical storage key', () => {
      expect(A11Y_INIT_SCRIPT).toContain(STORAGE_KEY);
    });
  });

  describe('missing or corrupt localStorage', () => {
    it('no-ops when localStorage is empty', () => {
      runInitScript();
      expect(a11yClasses()).toEqual([]);
    });

    it('does not throw when stored value is not valid JSON', () => {
      globalThis.window.localStorage.setItem(STORAGE_KEY, '{not valid json');
      expect(() => {
        runInitScript();
      }).not.toThrow();
      expect(a11yClasses()).toEqual([]);
    });

    it('does not throw when stored value is missing the state property', () => {
      globalThis.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 0 }));
      expect(() => {
        runInitScript();
      }).not.toThrow();
      expect(a11yClasses()).toEqual([]);
    });

    it('does not throw when state contains unknown keys', () => {
      globalThis.window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: { whatIsThis: 42, contrast: 'high' },
          version: 0,
        })
      );
      expect(() => {
        runInitScript();
      }).not.toThrow();
      expect(document.documentElement.classList.contains('a11y-contrast-high')).toBe(true);
    });

    it('does not throw when localStorage access throws (e.g. private mode)', () => {
      const localStorage = globalThis.window.localStorage;
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = (): string => {
        throw new Error('SecurityError');
      };
      try {
        expect(() => {
          runInitScript();
        }).not.toThrow();
        expect(a11yClasses()).toEqual([]);
      } finally {
        localStorage.getItem = originalGetItem;
      }
    });
  });

  describe('class application — visual', () => {
    it.each([
      ['increased', 'a11y-contrast-increased'],
      ['high', 'a11y-contrast-high'],
      ['low', 'a11y-contrast-low'],
    ] as const)('contrast %s applies %s', (value, className) => {
      setStoredPrefs({ contrast: value });
      runInitScript();
      expect(document.documentElement.classList.contains(className)).toBe(true);
    });

    it.each([
      ['0', 'a11y-saturate-0'],
      ['50', 'a11y-saturate-50'],
      ['150', 'a11y-saturate-150'],
    ] as const)('saturation %s applies %s', (value, className) => {
      setStoredPrefs({ saturation: value });
      runInitScript();
      expect(document.documentElement.classList.contains(className)).toBe(true);
    });

    it.each([
      ['protan', 'a11y-cb-protan'],
      ['deutan', 'a11y-cb-deutan'],
      ['tritan', 'a11y-cb-tritan'],
      ['achroma', 'a11y-cb-achroma'],
      ['achromatomaly', 'a11y-cb-achromatomaly'],
    ] as const)('colorblindSimulate %s applies %s', (value, className) => {
      setStoredPrefs({ colorblindSimulate: value });
      runInitScript();
      expect(document.documentElement.classList.contains(className)).toBe(true);
    });
  });

  describe('class application — typography (non-font)', () => {
    it.each([
      ['88', 'a11y-font-scale-88'],
      ['112', 'a11y-font-scale-112'],
      ['124', 'a11y-font-scale-124'],
      ['141', 'a11y-font-scale-141'],
    ] as const)('fontSize %s applies %s', (value, className) => {
      setStoredPrefs({ fontSize: value });
      runInitScript();
      expect(document.documentElement.classList.contains(className)).toBe(true);
    });

    it('letterSpacing 0.05 applies a11y-letter-spacing-loose', () => {
      setStoredPrefs({ letterSpacing: '0.05' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-letter-spacing-loose')).toBe(true);
    });

    it('letterSpacing 0.12 applies a11y-letter-spacing-loosest', () => {
      setStoredPrefs({ letterSpacing: '0.12' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-letter-spacing-loosest')).toBe(true);
    });

    it('lineHeight 1.5 applies a11y-line-height-tall', () => {
      setStoredPrefs({ lineHeight: '1.5' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-line-height-tall')).toBe(true);
    });

    it('lineHeight 2.0 applies a11y-line-height-double', () => {
      setStoredPrefs({ lineHeight: '2.0' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-line-height-double')).toBe(true);
    });

    it('lineHeight 1.0 applies neither tall nor double', () => {
      setStoredPrefs({ lineHeight: '1.0' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-line-height-tall')).toBe(false);
      expect(document.documentElement.classList.contains('a11y-line-height-double')).toBe(false);
    });

    it('paragraphSpacing 2 applies a11y-para-spacing-double', () => {
      setStoredPrefs({ paragraphSpacing: '2' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-para-spacing-double')).toBe(true);
    });
  });

  describe('class application — pointer & focus', () => {
    it.each([
      ['large', 'a11y-cursor-large'],
      ['xlarge', 'a11y-cursor-xlarge'],
    ] as const)('cursorSize %s applies %s', (value, className) => {
      setStoredPrefs({ cursorSize: value });
      runInitScript();
      expect(document.documentElement.classList.contains(className)).toBe(true);
    });

    it('cursorColor white applies a11y-cursor-white', () => {
      setStoredPrefs({ cursorColor: 'white' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-cursor-white')).toBe(true);
    });

    it('cursorColor black does not apply a11y-cursor-white', () => {
      setStoredPrefs({ cursorColor: 'black' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-cursor-white')).toBe(false);
    });

    it('focusHalo true with non-off focusWidth applies a11y-focus-strong and a11y-focus-halo', () => {
      setStoredPrefs({ focusWidth: '4', focusHalo: true });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-focus-strong')).toBe(true);
      expect(document.documentElement.classList.contains('a11y-focus-halo')).toBe(true);
    });

    it('does NOT apply a11y-focus-strong when focusWidth is "0" (off)', () => {
      setStoredPrefs({ focusWidth: '0' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-focus-strong')).toBe(false);
    });

    it('does NOT apply a11y-focus-strong at schema defaults (focusWidth is "0")', () => {
      setStoredPrefs();
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-focus-strong')).toBe(false);
    });

    it('non-off focusWidth applies a11y-focus-strong', () => {
      setStoredPrefs({ focusWidth: '4' });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-focus-strong')).toBe(true);
    });

    it('sets --a11y-focus-width on the documentElement', () => {
      setStoredPrefs({ focusWidth: '6' });
      runInitScript();
      expect(document.documentElement.style.getPropertyValue('--a11y-focus-width')).toBe('6px');
    });

    it('sets --a11y-focus-color on the documentElement', () => {
      setStoredPrefs({ focusColor: 'cyan' });
      runInitScript();
      expect(document.documentElement.style.getPropertyValue('--a11y-focus-color')).toBe('cyan');
    });
  });

  describe('class application — reduced motion (merged from two inputs)', () => {
    it('does not write the legacy a11y-stop-animations class', () => {
      setStoredPrefs({ stopAnimations: true });
      runInitScript();
      expect(document.documentElement.classList.contains('a11y-stop-animations')).toBe(false);
    });

    it('applies reduced-motion class when stored stopAnimations is true', () => {
      stubReducedMotionMediaQuery(false);
      setStoredPrefs({ stopAnimations: true });
      runInitScript();
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    });

    it('applies reduced-motion class when the OS prefers-reduced-motion media query matches', () => {
      stubReducedMotionMediaQuery(true);
      setStoredPrefs({ stopAnimations: false });
      runInitScript();
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    });

    it('applies reduced-motion class when OS pref matches even with empty localStorage', () => {
      stubReducedMotionMediaQuery(true);
      runInitScript();
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    });

    it('applies reduced-motion class when both inputs are on', () => {
      stubReducedMotionMediaQuery(true);
      setStoredPrefs({ stopAnimations: true });
      runInitScript();
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    });

    it('does not apply reduced-motion class when both inputs are off', () => {
      stubReducedMotionMediaQuery(false);
      setStoredPrefs({ stopAnimations: false });
      runInitScript();
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
    });

    it('does not apply reduced-motion class when matchMedia throws (private mode / minimal envs)', () => {
      Object.defineProperty(globalThis.window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: () => {
          throw new Error('blocked');
        },
      });
      setStoredPrefs({ stopAnimations: false });
      runInitScript();
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
    });
  });

  describe('font preload', () => {
    it.each([['atkinson'], ['open-dyslexic'], ['lexend']] as const)(
      'injects preload link for non-default font %s',
      (fontFamily) => {
        setStoredPrefs({ fontFamily });
        runInitScript();
        const link = document.head.querySelector('link[rel="preload"][as="font"]');
        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBe(`/fonts/a11y/${fontFamily}.woff2`);
        expect(link?.getAttribute('type')).toBe('font/woff2');
        expect(link?.getAttribute('crossorigin')).toBe('anonymous');
      }
    );

    it.each([['atkinson'], ['open-dyslexic'], ['lexend']] as const)(
      'injects @font-face style for non-default font %s with font-display: block',
      (fontFamily) => {
        setStoredPrefs({ fontFamily });
        runInitScript();
        const styles = [...document.head.querySelectorAll('style')];
        const fontFaceStyle = styles.find((s) => s.textContent.includes('@font-face'));
        expect(fontFaceStyle).toBeDefined();
        expect(fontFaceStyle?.textContent).toContain(`font-family: '${fontFamily}'`);
        expect(fontFaceStyle?.textContent).toContain(
          `url('/fonts/a11y/${fontFamily}.woff2') format('woff2')`
        );
        expect(fontFaceStyle?.textContent).toContain('font-display: block');
      }
    );

    it.each([['atkinson'], ['open-dyslexic'], ['lexend']] as const)(
      'injects html.a11y-font-override override style for %s',
      (fontFamily) => {
        setStoredPrefs({ fontFamily });
        runInitScript();
        const styles = [...document.head.querySelectorAll('style')];
        const overrideStyle = styles.find((s) => s.textContent.includes('html.a11y-font-override'));
        expect(overrideStyle).toBeDefined();
        expect(overrideStyle?.textContent).toContain(`font-family: '${fontFamily}'`);
      }
    );

    it.each([['atkinson'], ['open-dyslexic'], ['lexend']] as const)(
      'applies a11y-font-override class for %s',
      (fontFamily) => {
        setStoredPrefs({ fontFamily });
        runInitScript();
        expect(document.documentElement.classList.contains('a11y-font-override')).toBe(true);
      }
    );

    it('injects size-adjust: 85% in the @font-face block for open-dyslexic (otherwise it renders enormous)', () => {
      setStoredPrefs({ fontFamily: 'open-dyslexic' });
      runInitScript();
      const styles = [...document.head.querySelectorAll('style')];
      const fontFaceStyle = styles.find((s) => s.textContent.includes('@font-face'));
      expect(fontFaceStyle?.textContent).toContain('size-adjust: 85%');
    });

    it.each([['atkinson'], ['lexend']] as const)(
      'does not inject size-adjust for %s (only open-dyslexic needs the metric correction)',
      (fontFamily) => {
        setStoredPrefs({ fontFamily });
        runInitScript();
        const styles = [...document.head.querySelectorAll('style')];
        const fontFaceStyle = styles.find((s) => s.textContent.includes('@font-face'));
        expect(fontFaceStyle?.textContent).not.toContain('size-adjust');
      }
    );

    it('does not inject any font preload tags when fontFamily is system', () => {
      setStoredPrefs({ fontFamily: 'system' });
      runInitScript();
      expect(document.head.querySelector('link[rel="preload"][as="font"]')).toBeNull();
      const fontFaceStyles = [...document.head.querySelectorAll('style')].filter((s) =>
        s.textContent.includes('@font-face')
      );
      expect(fontFaceStyles).toEqual([]);
      expect(document.documentElement.classList.contains('a11y-font-override')).toBe(false);
    });

    it('does not inject font preload when localStorage is empty', () => {
      runInitScript();
      expect(document.head.querySelector('link[rel="preload"][as="font"]')).toBeNull();
    });
  });

  describe('multi-setting hydration', () => {
    it('applies every setting from a fully populated payload', () => {
      setStoredPrefs({
        contrast: 'high',
        saturation: '50',
        colorblindSimulate: 'protan',
        fontSize: '141',
        letterSpacing: '0.12',
        lineHeight: '2.0',
        paragraphSpacing: '2',
        fontFamily: 'lexend',
        stopAnimations: true,
        cursorSize: 'xlarge',
        cursorColor: 'white',
        focusWidth: '6',
        focusColor: 'magenta',
        focusHalo: true,
      });
      runInitScript();
      const expected = [
        'a11y-cb-protan',
        'a11y-contrast-high',
        'a11y-cursor-white',
        'a11y-cursor-xlarge',
        'a11y-focus-halo',
        'a11y-focus-strong',
        'a11y-font-override',
        'a11y-font-scale-141',
        'a11y-letter-spacing-loosest',
        'a11y-line-height-double',
        'a11y-para-spacing-double',
        'a11y-saturate-50',
      ];
      expect(a11yClasses()).toEqual(expected);
      expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    });
  });
});
