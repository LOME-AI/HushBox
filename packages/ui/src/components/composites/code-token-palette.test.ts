import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CODE_TOKEN_KINDS } from './code-block';

/**
 * The token file the console shares with every product app; the code palette
 * has to live beside the rest of the theme or the light and dark halves drift
 * apart from the surfaces they are read against.
 */
const TOKENS_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../config/tailwind/index.css'
  ),
  'utf8'
);

const [LIGHT, DARK] = ((): [string, string] => {
  const start = TOKENS_CSS.indexOf('.dark {');
  return [TOKENS_CSS.slice(0, start), TOKENS_CSS.slice(start)];
})();

describe('the code token palette', () => {
  it.each(CODE_TOKEN_KINDS)('gives %s a color in the light theme', (kind) => {
    expect(LIGHT).toMatch(new RegExp(String.raw`--code-${kind}:\s*#[0-9a-f]{6};`));
  });

  it.each(CODE_TOKEN_KINDS)('gives %s a color in the dark theme', (kind) => {
    expect(DARK).toMatch(new RegExp(String.raw`--code-${kind}:\s*#[0-9a-f]{6};`));
  });

  it.each(CODE_TOKEN_KINDS)('exposes %s as a utility the code block can name', (kind) => {
    expect(TOKENS_CSS).toContain(`--color-code-${kind}: var(--code-${kind});`);
  });
});
