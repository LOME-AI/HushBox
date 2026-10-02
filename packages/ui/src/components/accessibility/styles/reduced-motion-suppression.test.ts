import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const motionCss = readFileSync(path.join(stylesDir, 'motion.css'), 'utf8');

/**
 * The blanket rule's correctness is positional and its `!important` is
 * load-bearing: it has to reach every descendant and outrank the inline styles
 * Framer writes. Source text cannot tell a selector that matches from one that
 * does not, so these mount the stylesheet and read the value the cascade
 * actually resolved. The declared 5s stands in for a Framer inline duration.
 */
const DECLARED_DURATION = '5s';
const SUPPRESSED_DURATION = '0.01ms';

function mount(rootClassName: string): Element {
  const style = document.createElement('style');
  style.textContent = motionCss;
  document.head.append(style);
  document.documentElement.className = rootClassName;
  document.body.innerHTML = `<section><div id="animated" style="animation-duration: ${DECLARED_DURATION}; transition-duration: ${DECLARED_DURATION}"></div></section>`;
  return document.querySelector('#animated')!;
}

function reset(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.className = '';
}

beforeEach(reset);
afterEach(reset);

describe('reduced-motion suppression of declared durations', () => {
  it('collapses an animation duration declared inline on a nested descendant', () => {
    const animated = mount('reduced-motion');

    expect(globalThis.getComputedStyle(animated).animationDuration).toBe(SUPPRESSED_DURATION);
  });

  it('collapses a transition duration declared inline on a nested descendant', () => {
    const animated = mount('reduced-motion');

    expect(globalThis.getComputedStyle(animated).transitionDuration).toBe(SUPPRESSED_DURATION);
  });

  it('leaves declared durations standing when the root carries no reduced-motion class', () => {
    const animated = mount('');

    expect(globalThis.getComputedStyle(animated).animationDuration).toBe(DECLARED_DURATION);
    expect(globalThis.getComputedStyle(animated).transitionDuration).toBe(DECLARED_DURATION);
  });
});
