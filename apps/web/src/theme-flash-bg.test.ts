import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * `apps/web/index.html` paints a literal theme background before any CSS loads
 * (anti white-flash, notably in the demo iframe). It can't reference the
 * `--background` token — that token lives in CSS that hasn't loaded yet — so the
 * hex is necessarily duplicated. This guard fails loudly if the two ever drift,
 * turning a silent coupling into a caught one.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(HERE, '../index.html');
const TOKEN_CSS = path.resolve(HERE, '../../../packages/config/tailwind/index.css');

/** All `background-color: #hex` values, in document order. */
function htmlBackgroundColors(html: string): string[] {
  return [...html.matchAll(/background-color:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1] ?? '');
}

/** The `--background` token (exact, not `--background-paper`/`-subtle`) in a CSS region. */
function backgroundToken(css: string): string | undefined {
  return /--background:\s*(#[0-9a-fA-F]{3,8})/.exec(css)?.[1];
}

describe('index.html anti-flash background', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const css = readFileSync(TOKEN_CSS, 'utf8');
  const darkSelector = css.indexOf('.dark {');
  const lightToken = backgroundToken(css.slice(0, darkSelector));
  const darkToken = backgroundToken(css.slice(darkSelector));
  const [htmlLight, htmlDark] = htmlBackgroundColors(html);

  it('declares exactly a light and a dark background', () => {
    expect(htmlBackgroundColors(html)).toHaveLength(2);
  });

  it('matches the light --background token', () => {
    expect(htmlLight).toBe(lightToken);
  });

  it('matches the dark --background token', () => {
    expect(htmlDark).toBe(darkToken);
  });
});
