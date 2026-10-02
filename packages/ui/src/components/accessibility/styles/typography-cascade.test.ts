import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const typographyCss = readFileSync(path.join(stylesDir, 'typography.css'), 'utf8');

const A11Y_FACE = 'open-dyslexic';
const MONO_FACE = 'test-mono';

/**
 * Runs the shipped stylesheet through a real cascade instead of asserting on its
 * source text: the defect this pins was a selector that matched the elements it
 * named and nothing beneath them, which reads correct in the source and is only
 * visible in a computed value.
 */
function applyFontOverride(markup: string): void {
  const style = document.createElement('style');
  style.textContent = typographyCss;
  document.head.append(style);
  document.documentElement.classList.add('a11y-font-override');
  document.documentElement.style.setProperty('--a11y-font-family', A11Y_FACE);
  document.documentElement.style.setProperty('--font-mono', MONO_FACE);
  document.body.innerHTML = markup;
}

function computedFontFamily(selector: string): string {
  const element = document.querySelector(selector);
  expect(element).not.toBeNull();
  return globalThis.getComputedStyle(element!).fontFamily;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

describe('accessibility font override', () => {
  // Shiki emits <pre><code><span>, so the glyphs of every syntax-highlighted
  // block sit in a nested element rather than in the carved-out element itself.
  it.each([
    { subtree: 'code', markup: '<code><span id="target">const x = 1;</span></code>' },
    { subtree: 'pre', markup: '<pre><span id="target">const x = 1;</span></pre>' },
    { subtree: 'kbd', markup: '<kbd><span id="target">Ctrl</span></kbd>' },
  ])('keeps the mono face on text nested inside $subtree', ({ markup }) => {
    applyFontOverride(markup);

    expect(computedFontFamily('#target')).toContain(MONO_FACE);
  });

  it('keeps the mono face on text nested several elements deep inside code', () => {
    applyFontOverride('<pre><code><span><em id="target">const x = 1;</em></span></code></pre>');

    expect(computedFontFamily('#target')).toContain(MONO_FACE);
  });

  it('keeps the mono face on the carved-out element itself', () => {
    applyFontOverride('<code id="target">const x = 1;</code>');

    expect(computedFontFamily('#target')).toContain(MONO_FACE);
  });

  it('applies the accessibility face to text outside those subtrees', () => {
    applyFontOverride('<p><span id="target">prose</span></p>');

    expect(computedFontFamily('#target')).toContain(A11Y_FACE);
  });

  it('applies the accessibility face to an element that only follows a code block', () => {
    applyFontOverride('<pre><code>const x = 1;</code></pre><p id="target">prose</p>');

    expect(computedFontFamily('#target')).toContain(A11Y_FACE);
  });
});
