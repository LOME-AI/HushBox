import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const themeCss = readFileSync(
  path.join(stylesDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);

/** The elements code focuses that are not controls: a `main` landmark and the route heading. */
const FOCUS_TARGETS = ['main:focus-visible', "main h1[tabindex='-1']:focus-visible"];

interface Ruleset {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** The body of the first block opened by `opener`, delimited by balancing braces. */
function blockBody(css: string, opener: string): string {
  const start = css.indexOf(`${opener} {`);
  if (start === -1) throw new Error(`${opener} not found`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`${opener} is unterminated`);
}

/** The rulesets directly inside a block, comments dropped, nested blocks skipped. */
function rulesets(block: string): Ruleset[] {
  const source = block.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const found: Ruleset[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '{') {
      if (depth === 0) bodyStart = index + 1;
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const selectors = source
          .slice(selectorStart, bodyStart - 1)
          .split(',')
          .map((selector) => selector.trim().replaceAll('"', "'"));
        found.push({ selectors, body: source.slice(bodyStart, index) });
        selectorStart = index + 1;
      }
    }
  }
  return found;
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(String.raw`(?:^|;|\s)${property}:\s*([^;]+)`).exec(body)?.[1]?.trim();
}

/**
 * Code moves focus to a `main` landmark and to the route announcer's heading. A click that
 * focuses one never matches `:focus-visible`. Without this rule their keyboard-visible
 * outline would be the browser's default rather than the Signal Red ring. The rule sits in
 * the base layer so that the demo's unlayered suppression and the accessibility layer's
 * `!important` strong-focus override both win.
 */
describe('focus-target ring', () => {
  const rule = rulesets(blockBody(themeCss, '@layer base')).find(
    (candidate) =>
      candidate.selectors.length === FOCUS_TARGETS.length &&
      FOCUS_TARGETS.every((selector) => candidate.selectors.includes(selector))
  );

  it('outlines a focused main landmark and route heading with the ring token', () => {
    expect(declaration(rule?.body ?? '', 'outline')).toBe('2px solid var(--color-ring)');
  });

  it('draws the ring inside the element so a viewport-filling landmark cannot clip it', () => {
    expect(declaration(rule?.body ?? '', 'outline-offset')).toBe('-2px');
  });

  it('leaves the demo suppression and the strong-focus override able to win', () => {
    expect(rule?.body).not.toMatch(/!important/);
  });
});
