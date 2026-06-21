import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { THEME_FLASH_SCRIPT, resolvePrePaintDark } from './theme-flash-script';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(HERE, '../../index.html');
const THEME_SCRIPT_ASTRO = path.resolve(
  HERE,
  '../../../marketing/src/components/ThemeScript.astro'
);

function resolve(options: {
  saved: string | null;
  prefersDark: boolean;
  throwOnGet?: boolean;
}): boolean {
  return resolvePrePaintDark({
    getThemeMode: () => {
      if (options.throwOnGet) throw new Error('storage blocked');
      return options.saved;
    },
    prefersDark: () => options.prefersDark,
  });
}

describe('resolvePrePaintDark resolution', () => {
  it('applies dark when themeMode is explicitly dark on a light OS', () => {
    expect(resolve({ saved: 'dark', prefersDark: false })).toBe(true);
  });

  it('does not apply dark when themeMode is explicitly light on a dark OS', () => {
    expect(resolve({ saved: 'light', prefersDark: true })).toBe(false);
  });

  it('follows the OS dark preference when no themeMode is stored', () => {
    expect(resolve({ saved: null, prefersDark: true })).toBe(true);
  });

  it('stays light when no themeMode is stored and the OS prefers light', () => {
    expect(resolve({ saved: null, prefersDark: false })).toBe(false);
  });

  it('does not throw and resolves light when storage access throws', () => {
    expect(() => resolve({ saved: null, prefersDark: false, throwOnGet: true })).not.toThrow();
    expect(resolve({ saved: null, prefersDark: false, throwOnGet: true })).toBe(false);
  });
});

describe('index.html pre-paint theme script', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');

  it('embeds the shipped snippet so the tested logic is what ships', () => {
    // Compare line-by-line trimmed so the guarantee survives index.html's
    // indentation and Prettier reformatting without weakening the coupling.
    const trimLines = (s: string): string =>
      s
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
    expect(trimLines(html)).toContain(trimLines(THEME_FLASH_SCRIPT));
  });

  it('references the themeMode storage key', () => {
    expect(THEME_FLASH_SCRIPT).toContain('themeMode');
  });

  it('toggles the dark class', () => {
    expect(THEME_FLASH_SCRIPT).toContain("classList.toggle('dark'");
  });

  it('wraps storage access in try/catch', () => {
    expect(THEME_FLASH_SCRIPT).toContain('try');
    expect(THEME_FLASH_SCRIPT).toContain('catch');
  });
});

describe('parity with marketing ThemeScript.astro', () => {
  const astro = readFileSync(THEME_SCRIPT_ASTRO, 'utf8');

  it('uses the same storage key as marketing', () => {
    expect(astro).toContain('themeMode');
    expect(THEME_FLASH_SCRIPT).toContain('themeMode');
  });

  it('uses the same prefers-color-scheme query as marketing', () => {
    expect(astro).toContain('(prefers-color-scheme: dark)');
    expect(THEME_FLASH_SCRIPT).toContain('(prefers-color-scheme: dark)');
  });

  it('resolves dark identically to marketing for the same inputs', () => {
    // Marketing resolution: dark iff saved==='dark' OR (no saved AND OS dark).
    const cases: { saved: string | null; prefersDark: boolean }[] = [
      { saved: 'dark', prefersDark: false },
      { saved: 'dark', prefersDark: true },
      { saved: 'light', prefersDark: false },
      { saved: 'light', prefersDark: true },
      { saved: null, prefersDark: false },
      { saved: null, prefersDark: true },
    ];
    for (const c of cases) {
      const marketingDark = c.saved === 'dark' || (!c.saved && c.prefersDark);
      expect(resolve(c)).toBe(marketingDark);
    }
  });
});
