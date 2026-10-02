// @ts-check
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The global rules every primitive relies on, read from the stylesheet's hand-written
 * part: everything after the generated token block, which the token generator never
 * rewrites.
 */

const STYLESHEET = path.join(import.meta.dirname, 'index.css');
const END = '/* END GENERATED: design-tokens */';
const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/** @returns {string} */
function handWritten() {
  const css = readFileSync(STYLESHEET, 'utf8');
  const end = css.indexOf(END);
  if (end === -1) throw new Error(`${STYLESHEET} has no end-of-token-block marker`);
  return css.slice(end + END.length).replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The body of the first block opened by `opener`, delimited by balancing braces.
 * @param {string} css
 * @param {string} opener
 * @returns {string}
 */
function blockBody(css, opener) {
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

/**
 * A selector list with its whitespace normalised.
 * @param {string} selectors
 * @returns {string}
 */
function normalised(selectors) {
  return selectors
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*,\s*/g, ', ')
    .trim();
}

/**
 * The rulesets directly inside `block`, nested blocks included whole in their body.
 * @param {string} block
 * @returns {{ selectors: string, body: string }[]}
 */
function rulesets(block) {
  const found = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index];
    if (char === '{' && depth++ === 0) bodyStart = index + 1;
    if (char === '}' && --depth === 0) {
      found.push({
        selectors: normalised(block.slice(selectorStart, bodyStart - 1)),
        body: block.slice(bodyStart, index),
      });
      selectorStart = index + 1;
    }
  }
  return found;
}

/**
 * The declarations of the ruleset directly inside `block` whose selector list is
 * `selectors`; undefined when there is none.
 * @param {string} block
 * @param {string} selectors
 * @returns {string | undefined}
 */
function ruleBody(block, selectors) {
  return rulesets(block).find((ruleset) => ruleset.selectors === selectors)?.body;
}

/**
 * @param {string | undefined} body
 * @param {string} property
 * @returns {string | undefined}
 */
function declaration(body, property) {
  return new RegExp(String.raw`(?:^|;|\s)${property}:\s*([^;]+)`).exec(body ?? '')?.[1]?.trim();
}

const base = blockBody(handWritten(), '@layer base');

describe('the base focus outline', () => {
  const rule = ruleBody(base, ':focus-visible');

  it('draws a solid 2px outline in the ring colour on keyboard-visible focus', () => {
    expect(declaration(rule, 'outline')).toBe('2px solid var(--color-ring)');
  });

  it('sets the outline 2px off the element', () => {
    expect(declaration(rule, 'outline-offset')).toBe('2px');
  });

  it("leaves the accessibility widget's strong-focus override able to replace it", () => {
    expect(rule).not.toMatch(/!important/);
  });
});

describe('heading wrapping', () => {
  it('balances every heading', () => {
    expect(declaration(ruleBody(base, HEADINGS), 'text-wrap')).toBe('balance');
  });

  it('wraps a heading inside a reply or a blog post plainly', () => {
    const rule = ruleBody(base, `:is(.prose, .prose-blog) :is(${HEADINGS})`);

    expect(declaration(rule, 'text-wrap')).toBe('wrap');
  });
});

describe('key hints', () => {
  const query = '@media (width < 48rem), (pointer: coarse)';
  const hints = base.includes(query) ? blockBody(base, query) : '';
  const hidden = 'kbd:not([data-always-visible])';

  it('hides a plain key hint below 768px and on a coarse pointer', () => {
    expect(declaration(ruleBody(hints, hidden), 'display')).toBe('none !important');
  });

  it('leaves a key marked always visible out of every rule that hides keys there', () => {
    expect(rulesets(hints).map((ruleset) => ruleset.selectors)).toEqual([hidden]);
  });
});
