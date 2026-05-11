import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import type { AccessibilityPreferences } from '@hushbox/shared';
import { applySettings } from './apply-settings';

function createRoot(): HTMLElement {
  return document.createElement('html');
}

function makePrefs(overrides: Partial<AccessibilityPreferences> = {}): AccessibilityPreferences {
  return { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ...overrides };
}

function classes(root: HTMLElement): string[] {
  return [...root.classList].toSorted((a, b) => a.localeCompare(b));
}

describe('applySettings', () => {
  describe('defaults', () => {
    it('adds only the schema-default classes (a11y-line-height-tall — schema default is "1.5")', () => {
      const root = createRoot();
      applySettings(makePrefs(), root);
      expect(classes(root).filter((c) => c.startsWith('a11y-'))).toEqual(['a11y-line-height-tall']);
    });

    it('preserves non-a11y classes already on the root (does not clobber)', () => {
      const root = createRoot();
      root.classList.add('dark', 'preserved');
      applySettings(makePrefs(), root);
      expect(root.classList.contains('dark')).toBe(true);
      expect(root.classList.contains('preserved')).toBe(true);
    });
  });

  describe('contrast', () => {
    it.each([
      ['increased', 'a11y-contrast-increased'],
      ['high', 'a11y-contrast-high'],
      ['low', 'a11y-contrast-low'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ contrast: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when contrast is normal', () => {
      const root = createRoot();
      applySettings(makePrefs({ contrast: 'normal' }), root);
      expect(root.classList.contains('a11y-contrast-normal')).toBe(false);
    });

    it('removes a stale contrast class when toggled off', () => {
      const root = createRoot();
      root.classList.add('a11y-contrast-high');
      applySettings(makePrefs({ contrast: 'normal' }), root);
      expect(root.classList.contains('a11y-contrast-high')).toBe(false);
    });

    it('replaces a stale contrast class when changed', () => {
      const root = createRoot();
      root.classList.add('a11y-contrast-high');
      applySettings(makePrefs({ contrast: 'low' }), root);
      expect(root.classList.contains('a11y-contrast-high')).toBe(false);
      expect(root.classList.contains('a11y-contrast-low')).toBe(true);
    });
  });

  describe('saturation', () => {
    it.each([
      ['0', 'a11y-saturate-0'],
      ['50', 'a11y-saturate-50'],
      ['150', 'a11y-saturate-150'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ saturation: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when saturation is 100', () => {
      const root = createRoot();
      applySettings(makePrefs({ saturation: '100' }), root);
      expect(root.classList.contains('a11y-saturate-100')).toBe(false);
    });
  });

  describe('invert', () => {
    it('applies a11y-invert when true', () => {
      const root = createRoot();
      applySettings(makePrefs({ invert: true }), root);
      expect(root.classList.contains('a11y-invert')).toBe(true);
    });

    it('skips a11y-invert when false', () => {
      const root = createRoot();
      applySettings(makePrefs({ invert: false }), root);
      expect(root.classList.contains('a11y-invert')).toBe(false);
    });
  });

  describe('highlightLinks', () => {
    it('applies a11y-highlight-links when true', () => {
      const root = createRoot();
      applySettings(makePrefs({ highlightLinks: true }), root);
      expect(root.classList.contains('a11y-highlight-links')).toBe(true);
    });

    it('skips a11y-highlight-links when false', () => {
      const root = createRoot();
      applySettings(makePrefs({ highlightLinks: false }), root);
      expect(root.classList.contains('a11y-highlight-links')).toBe(false);
    });
  });

  describe('colorblindSimulate', () => {
    it.each([
      ['protan', 'a11y-cb-protan'],
      ['deutan', 'a11y-cb-deutan'],
      ['tritan', 'a11y-cb-tritan'],
      ['achroma', 'a11y-cb-achroma'],
      ['achromatomaly', 'a11y-cb-achromatomaly'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ colorblindSimulate: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when colorblindSimulate is none', () => {
      const root = createRoot();
      applySettings(makePrefs({ colorblindSimulate: 'none' }), root);
      const callbackClasses = classes(root).filter((c) => c.startsWith('a11y-cb-'));
      expect(callbackClasses).toEqual([]);
    });

    it('replaces a stale simulate class when changed to a different type', () => {
      const root = createRoot();
      root.classList.add('a11y-cb-protan');
      applySettings(makePrefs({ colorblindSimulate: 'deutan' }), root);
      expect(root.classList.contains('a11y-cb-protan')).toBe(false);
      expect(root.classList.contains('a11y-cb-deutan')).toBe(true);
    });
  });

  describe('fontSize', () => {
    it.each([
      ['125', 'a11y-font-scale-125'],
      ['150', 'a11y-font-scale-150'],
      ['175', 'a11y-font-scale-175'],
      ['200', 'a11y-font-scale-200'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ fontSize: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when fontSize is 100', () => {
      const root = createRoot();
      applySettings(makePrefs({ fontSize: '100' }), root);
      const sizeClasses = classes(root).filter((c) => c.startsWith('a11y-font-scale-'));
      expect(sizeClasses).toEqual([]);
    });
  });

  describe('letterSpacing', () => {
    it.each([
      ['0.05', 'a11y-letter-spacing-loose'],
      ['0.12', 'a11y-letter-spacing-loosest'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ letterSpacing: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when letterSpacing is 0', () => {
      const root = createRoot();
      applySettings(makePrefs({ letterSpacing: '0' }), root);
      const lsClasses = classes(root).filter((c) => c.startsWith('a11y-letter-spacing-'));
      expect(lsClasses).toEqual([]);
    });
  });

  describe('lineHeight', () => {
    it.each([
      ['1.5', 'a11y-line-height-tall'],
      ['2.0', 'a11y-line-height-double'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ lineHeight: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when lineHeight is 1.0', () => {
      const root = createRoot();
      applySettings(makePrefs({ lineHeight: '1.0' }), root);
      const lhClasses = classes(root).filter((c) => c.startsWith('a11y-line-height-'));
      expect(lhClasses).toEqual([]);
    });
  });

  describe('paragraphSpacing', () => {
    it('applies a11y-para-spacing-double when 2', () => {
      const root = createRoot();
      applySettings(makePrefs({ paragraphSpacing: '2' }), root);
      expect(root.classList.contains('a11y-para-spacing-double')).toBe(true);
    });

    it('skips class when paragraphSpacing is 1', () => {
      const root = createRoot();
      applySettings(makePrefs({ paragraphSpacing: '1' }), root);
      expect(root.classList.contains('a11y-para-spacing-double')).toBe(false);
    });
  });

  describe('forceLeftAlign', () => {
    it('applies a11y-force-left when true', () => {
      const root = createRoot();
      applySettings(makePrefs({ forceLeftAlign: true }), root);
      expect(root.classList.contains('a11y-force-left')).toBe(true);
    });

    it('skips a11y-force-left when false', () => {
      const root = createRoot();
      applySettings(makePrefs({ forceLeftAlign: false }), root);
      expect(root.classList.contains('a11y-force-left')).toBe(false);
    });
  });

  describe('fontFamily', () => {
    it.each([['atkinson'], ['open-dyslexic'], ['lexend']] as const)(
      'applies a11y-font-override when %s',
      (value) => {
        const root = createRoot();
        applySettings(makePrefs({ fontFamily: value }), root);
        expect(root.classList.contains('a11y-font-override')).toBe(true);
      }
    );

    it('skips a11y-font-override when system', () => {
      const root = createRoot();
      applySettings(makePrefs({ fontFamily: 'system' }), root);
      expect(root.classList.contains('a11y-font-override')).toBe(false);
    });
  });

  describe('stopAnimations', () => {
    it('applies a11y-stop-animations when true', () => {
      const root = createRoot();
      applySettings(makePrefs({ stopAnimations: true }), root);
      expect(root.classList.contains('a11y-stop-animations')).toBe(true);
    });

    it('skips a11y-stop-animations when false', () => {
      const root = createRoot();
      applySettings(makePrefs({ stopAnimations: false }), root);
      expect(root.classList.contains('a11y-stop-animations')).toBe(false);
    });

    it('removes a11y-stop-animations when toggled off', () => {
      const root = createRoot();
      root.classList.add('a11y-stop-animations');
      applySettings(makePrefs({ stopAnimations: false }), root);
      expect(root.classList.contains('a11y-stop-animations')).toBe(false);
    });
  });

  describe('cursorSize', () => {
    it.each([
      ['large', 'a11y-cursor-large'],
      ['xlarge', 'a11y-cursor-xlarge'],
    ] as const)('applies %s as %s', (value, className) => {
      const root = createRoot();
      applySettings(makePrefs({ cursorSize: value }), root);
      expect(root.classList.contains(className)).toBe(true);
    });

    it('skips class when cursorSize is normal', () => {
      const root = createRoot();
      applySettings(makePrefs({ cursorSize: 'normal' }), root);
      const cursorClasses = classes(root).filter(
        (c) => c === 'a11y-cursor-large' || c === 'a11y-cursor-xlarge'
      );
      expect(cursorClasses).toEqual([]);
    });
  });

  describe('cursorColor', () => {
    it('applies a11y-cursor-white when white', () => {
      const root = createRoot();
      applySettings(makePrefs({ cursorColor: 'white' }), root);
      expect(root.classList.contains('a11y-cursor-white')).toBe(true);
    });

    it('does not apply a11y-cursor-white when black', () => {
      const root = createRoot();
      applySettings(makePrefs({ cursorColor: 'black' }), root);
      expect(root.classList.contains('a11y-cursor-white')).toBe(false);
    });
  });

  describe('focus indicator (width/color/halo)', () => {
    it('applies a11y-focus-strong when focusWidth is non-default', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusWidth: '4' }), root);
      expect(root.classList.contains('a11y-focus-strong')).toBe(true);
    });

    it('applies a11y-focus-strong when focusColor is non-default', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusColor: 'magenta' }), root);
      expect(root.classList.contains('a11y-focus-strong')).toBe(true);
    });

    it('applies a11y-focus-strong when focusHalo is true', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusHalo: true }), root);
      expect(root.classList.contains('a11y-focus-strong')).toBe(true);
    });

    it('does not apply a11y-focus-strong when all focus settings are at defaults', () => {
      const root = createRoot();
      applySettings(makePrefs(), root);
      expect(root.classList.contains('a11y-focus-strong')).toBe(false);
    });

    it('also applies a11y-focus-halo when focusHalo is true', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusHalo: true }), root);
      expect(root.classList.contains('a11y-focus-halo')).toBe(true);
    });

    it('skips a11y-focus-halo when focusHalo is false', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusHalo: false }), root);
      expect(root.classList.contains('a11y-focus-halo')).toBe(false);
    });

    it('sets --a11y-focus-width CSS variable on the root element', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusWidth: '6' }), root);
      expect(root.style.getPropertyValue('--a11y-focus-width')).toBe('6px');
    });

    it('sets --a11y-focus-color CSS variable on the root element', () => {
      const root = createRoot();
      applySettings(makePrefs({ focusColor: 'cyan' }), root);
      expect(root.style.getPropertyValue('--a11y-focus-color')).toBe('cyan');
    });

    it.each([
      ['yellow', 'yellow'],
      ['magenta', 'magenta'],
      ['cyan', 'cyan'],
      ['lime', 'lime'],
      ['red', 'red'],
    ] as const)('sets focus color CSS variable to %s', (focusColor, expected) => {
      const root = createRoot();
      applySettings(makePrefs({ focusColor }), root);
      expect(root.style.getPropertyValue('--a11y-focus-color')).toBe(expected);
    });

    it.each([
      ['2', '2px'],
      ['4', '4px'],
      ['6', '6px'],
    ] as const)('sets focus width CSS variable for value %s', (focusWidth, expected) => {
      const root = createRoot();
      applySettings(makePrefs({ focusWidth }), root);
      expect(root.style.getPropertyValue('--a11y-focus-width')).toBe(expected);
    });
  });

  describe('idempotency', () => {
    it('is idempotent: calling twice with same prefs gives same classList', () => {
      const root = createRoot();
      const prefs = makePrefs({
        contrast: 'high',
        invert: true,
        fontSize: '150',
        cursorSize: 'large',
        cursorColor: 'white',
        focusWidth: '4',
        focusHalo: true,
      });
      applySettings(prefs, root);
      const first = classes(root);
      applySettings(prefs, root);
      const second = classes(root);
      expect(second).toEqual(first);
    });
  });

  describe('default root parameter', () => {
    let originalClassName: string;
    let originalStyle: string;

    beforeEach(() => {
      originalClassName = document.documentElement.className;
      originalStyle = document.documentElement.getAttribute('style') ?? '';
    });

    afterEach(() => {
      document.documentElement.className = originalClassName;
      if (originalStyle) {
        document.documentElement.setAttribute('style', originalStyle);
      } else {
        document.documentElement.removeAttribute('style');
      }
    });

    it('defaults to document.documentElement when root is omitted', () => {
      applySettings(makePrefs({ contrast: 'high' }));
      expect(document.documentElement.classList.contains('a11y-contrast-high')).toBe(true);
    });
  });

  describe('full toggle off', () => {
    it('clears every a11y-* class set by a previous full-on apply', () => {
      const root = createRoot();
      applySettings(
        makePrefs({
          contrast: 'high',
          saturation: '0',
          invert: true,
          highlightLinks: true,
          colorblindSimulate: 'protan',
          fontSize: '200',
          letterSpacing: '0.12',
          lineHeight: '2.0',
          paragraphSpacing: '2',
          forceLeftAlign: true,
          fontFamily: 'atkinson',
          stopAnimations: true,
          cursorSize: 'large',
          cursorColor: 'white',
          focusWidth: '4',
          focusHalo: true,
        }),
        root
      );
      applySettings(makePrefs(), root);
      const remaining = classes(root).filter((c) => c.startsWith('a11y-'));
      expect(remaining).toEqual(['a11y-line-height-tall']);
    });
  });
});
