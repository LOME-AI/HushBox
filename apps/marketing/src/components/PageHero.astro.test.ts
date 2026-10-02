import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { compile } from 'tailwindcss';

// No DOM harness renders `.astro` files in this app, so the header is asserted against
// its source (mirrors ThemeScript.astro.test.ts), and the full-screen title leading
// against the CSS Tailwind compiles from the classes the source names.
const source = readFileSync(path.resolve(__dirname, './PageHero.astro'), 'utf8');
// The site stylesheet imports Tailwind whole, so its default theme supplies the width steps.
const DEFAULT_THEME = createRequire(import.meta.url).resolve('tailwindcss/theme.css');

/** The classes the source gives the full-screen hero's content, beyond the compact one's. */
function fullscreenContentClasses(): string {
  const match = /fullscreen \? '([^']+)'/.exec(source.split('const contentClass')[1] ?? '');
  if (match?.[1] === undefined) throw new Error('PageHero gives full-screen content no classes');
  return match[1];
}

/** The utility CSS the full-screen content classes compile to, less Tailwind's property registrations. */
async function fullscreenContentCss(): Promise<string> {
  const compiler = await compile(`${readFileSync(DEFAULT_THEME, 'utf8')}\n@tailwind utilities;\n`, {
    base: __dirname,
  });
  const css = compiler.build(fullscreenContentClasses().split(' '));
  const registrations = css.indexOf('@property');
  return registrations === -1 ? css : css.slice(0, registrations);
}

describe('PageHero title', () => {
  it('renders the title prop as a level-one Heading in the site hero role', () => {
    expect(source).toContain("import { Heading } from '@hushbox/ui/type'");
    expect(source).toMatch(/<Heading level=\{1\} variant="site-hero">\s*\{title\}\s*<\/Heading>/);
  });

  it('writes no raw heading element', () => {
    expect(source).not.toMatch(/<h[1-6]\b/);
  });

  it('adds no width step other than 768', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });
});

describe('PageHero content width', () => {
  // A title word wider than a phone, as under the widget's largest type, breaks inside
  // itself instead of widening the page; words that fit wrap exactly as before.
  it('lets the content shrink to the header and break a word only when it cannot fit', () => {
    const base = /const contentClass = \[\s*'([^']+)'/.exec(source)?.[1] ?? '';

    expect(base.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'wrap-break-word']));
  });
});

describe('PageHero full-screen title leading', () => {
  // Measured in Chromium on the live site; happy-dom resolves Tailwind's registered
  // `--tw-leading` to `normal`, so here the compiled rule is asserted instead.
  // Only a hero-sized title sets solid; a site-title headline keeps its own stepped leading.
  it('sets a descendant hero title leading to 1 inside the 768 step', async () => {
    const css = await fullscreenContentCss();

    expect(css).toMatch(
      /@media \(width >= 48rem\) \{\s*\.[^{]+ h1\.text-site-hero \{\s*--tw-leading: 1;\s*line-height: 1;\s*\}\s*\}/
    );
  });

  it('sets no leading outside the 768 step', async () => {
    const css = await fullscreenContentCss();
    const outsideStep = css.replaceAll(/@media \(width >= 48rem\) \{[^}]*\{[^}]*\}\s*\}/g, '');

    expect(outsideStep).not.toContain('line-height');
  });

  it('leaves the compact header content without a leading rule', () => {
    expect(source).toMatch(/fullscreen \? '[^']+' : ''/);
  });
});
