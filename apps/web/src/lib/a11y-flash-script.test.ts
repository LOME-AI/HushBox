import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { A11Y_INIT_SCRIPT } from '@hushbox/ui/accessibility/init-script';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(HERE, '../../index.html');

/**
 * Normalize away the only differences Prettier is allowed to introduce between
 * the shipped constant and its inline copy: it owns index.html, so it rewrites
 * line-wrapping and single/double quote style. Everything load-bearing —
 * identifiers, storage key, class names, string content, control flow — must
 * still match, so any logic drift between the two copies fails the parity test.
 * (The shorter theme pre-paint script gets away with a plain per-line trim
 * because it was authored in Prettier-conformant style; this one cannot.)
 */
function normalizeScript(s: string): string {
  return s.replaceAll(/["']/g, '"').replaceAll(/\s+/g, ' ').replaceAll('{ }', '{}').trim();
}

describe('index.html pre-paint accessibility script', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');

  it('embeds the shipped A11Y_INIT_SCRIPT so accessibility prefs apply before first paint', () => {
    expect(normalizeScript(html)).toContain(normalizeScript(A11Y_INIT_SCRIPT));
  });

  it('places the accessibility script inside the <head>', () => {
    const headEnd = html.indexOf('</head>');
    const normalizedHtml = normalizeScript(html);
    const scriptStart = normalizedHtml.indexOf(normalizeScript(A11Y_INIT_SCRIPT));
    expect(headEnd).toBeGreaterThan(-1);
    expect(scriptStart).toBeGreaterThan(-1);
    // The embedded script must precede </head> in the normalized source.
    expect(normalizedHtml.indexOf(normalizeScript('</head>'))).toBeGreaterThan(scriptStart);
  });
});
