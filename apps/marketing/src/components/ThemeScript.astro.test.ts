import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// No DOM harness renders `.astro` files in this app, so the injection is asserted
// against the component source (mirrors SiteLayout.astro.test.ts). What the
// script resolves is pinned where it lives, by the packages/ui suite that
// executes the shipped string.
const source = readFileSync(path.resolve(__dirname, './ThemeScript.astro'), 'utf8');

describe('ThemeScript', () => {
  it('injects the shared pre-paint theme script', () => {
    expect(source).toContain("import { THEME_INIT_SCRIPT } from '@hushbox/ui/theme/init-script'");
    expect(source).toContain('set:html={THEME_INIT_SCRIPT}');
  });

  it('keeps the script blocking so it runs before first paint', () => {
    expect(source).toMatch(/<script\b[^>]*\sis:inline\b/);
  });

  it('states no theme resolution of its own', () => {
    expect(source).not.toContain('themeMode');
    expect(source).not.toContain('prefers-color-scheme');
    expect(source).not.toContain('classList');
  });
});
