/**
 * A rule that declines an element declines what inherits from it.
 *
 * Three rules name tags they will not report on — `tiny-text` names the
 * elements a page deliberately sets small, and `tight-leading` and
 * `all-caps-body` name the headings a page is allowed to set tight and
 * uppercase. Each of those exclusions read the element's OWN tag only, while
 * the value each rule judges — `font-size`, `line-height`, `text-transform` —
 * reaches every descendant that declares none of its own. So a `<span>` inside
 * a bare `<sub>` was reported at the size the `<sub>` gave it, which is the
 * excluded element's own rendering arriving under a different tag name.
 *
 * WHERE THE INHERITANCE ANSWER COMES FROM. That each of these three properties
 * transmits and that the properties the detector's other tag-keyed skips gate
 * on do not is read off a real render — off what a browser's layout does with
 * the nested element, not off this engine, which is the thing these cases
 * grade, and not off memory. Re-taking it means rendering the nesting again
 * and reading the computed value on the descendant.
 *
 * WHAT STAYS ELEMENT-KEYED. The colour checks' `SAFE_TAGS` is the fourth skip
 * over an inherited property and is deliberately untouched: it is a constant
 * four rules share, it contains `html` and `body`, and an ancestor test whose
 * set contains a universal ancestor decides every element on a page rather than
 * a named few.
 *
 * WHAT THAT WOULD COST IS A DERIVATION, AND THE COUNT ALONE UNDERSTATES IT.
 * Because `body` and `html` are both in that set, every element of a
 * well-formed document has a member of the set above it — so the ancestor
 * reading matches everywhere and the colour checks collapse to an
 * unconditional `return []`. The cost is every contrast finding the tool can
 * produce, not some number of them. Driven over this repository the same
 * reading drops ten real contrast findings, and that ten is a fact about this
 * corpus rather than about the rule: the largest HTML file in it carries no
 * `<body>` element at all, so the walk runs out of ancestors before it reaches
 * one. A narrower variant testing the tag of the element that DECLARES the
 * colour, rather than every ancestor, drops seven of the same corpus's
 * findings. Read the derivation before either number: the cheap-looking option
 * is cheap only here.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Run them on
 * their own with `node --test` and an explicit file list; a bare directory
 * argument is an invocation error, not a red suite.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectHtml } from './engines/static-html/detect-html.mjs';

/**
 * A full page, since the page-level analyzers refuse anything without a
 * doctype, an `<html>` and a `<head>`. The `<img src="">` is an engine control
 * rather than decoration: it makes the engine emit `broken-image` on every page
 * here, so a silent verdict is a silent rule and not an engine that never ran.
 *
 * @param {string} style
 * @param {string} body
 */
function page(style, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title>
<style>${style}</style></head>
<body>${body}<img src=""></body></html>`;
}

/** The engine control: the finding every page here produces. */
const CONTROL = 'broken-image';

/** The stamp the static-HTML engine writes at its exit. Its absence means the
 *  parser dependencies were missing and the regex engine answered instead. */
const STATIC_STAMP = 'static-html';

/** Longer than the twenty characters `tiny-text` needs. */
const SHORT_COPY = 'Body copy that is comfortably longer than twenty characters.';
/** Longer than the fifty characters `tight-leading` needs. */
const LONG_COPY = 'Body copy that is comfortably longer than fifty characters in total length.';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-skip-inheritance-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/**
 * Run one page through the static-HTML engine and return the snippets it
 * emitted for one rule.
 *
 * @param {string} html
 * @param {string} rule
 * @returns {Promise<string[]>}
 */
async function staticFindings(html, rule) {
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(file, html, 'utf-8');
  const found = await detectHtml(file, {});
  assert.ok(
    found.some((f) => f.antipattern === CONTROL && f.engine === STATIC_STAMP),
    'engine control: the static-HTML engine must have run on this page'
  );
  return found.filter((f) => f.antipattern === rule).map((f) => f.snippet);
}

// --- tiny-text ---------------------------------------------------------------
//
// The carded shape: the default sheet sizes a bare `<sub>` at 0.83 of the size
// above it, so the span inside one renders at 11.67px under a 14px parent and
// was reported as body text set too small.

test('text inside a sub is not reported at the size the sub gives it', async () => {
  const found = await staticFindings(
    page('', `<div style="font-size:14px"><sub><span>${SHORT_COPY}</span></sub></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('text inside a code element is not reported at the size it inherits', async () => {
  const found = await staticFindings(
    page('', `<div style="font-size:11px"><code><span>${SHORT_COPY}</span></code></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('text inside a figcaption is not reported at the size it inherits', async () => {
  const found = await staticFindings(
    page('', `<figure style="font-size:11px"><figcaption><span>${SHORT_COPY}</span></figcaption></figure>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('text under no excluded element is still reported at a size below the floor', async () => {
  const found = await staticFindings(
    page('', `<div style="font-size:11px"><span>${SHORT_COPY}</span></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['11px body text']);
});

// --- tight-leading -----------------------------------------------------------

test('text inside a heading is not reported at the leading the heading sets', async () => {
  const found = await staticFindings(
    page('h2{line-height:1.1}', `<h2><span>${LONG_COPY}</span></h2>`),
    'tight-leading'
  );
  assert.deepEqual(found, []);
});

test('text under no heading is still reported at leading below the floor', async () => {
  const found = await staticFindings(
    page('div{line-height:1.1}', `<div><span>${LONG_COPY}</span></div>`),
    'tight-leading'
  );
  assert.deepEqual(found, ['line-height 1.10x (need >=1.3)']);
});

// --- all-caps-body -----------------------------------------------------------
//
// A heading is allowed to be uppercase, and in valid HTML a heading holds
// phrasing content only — so text under an uppercase heading is that heading's
// own text arriving under a different tag name, not a body passage.

test('text inside a heading is not reported for the case the heading sets', async () => {
  const found = await staticFindings(
    page('h2{text-transform:uppercase}', `<h2><span>${LONG_COPY}</span></h2>`),
    'all-caps-body'
  );
  assert.deepEqual(found, []);
});

test('text under no heading is still reported for uppercase it inherits', async () => {
  const found = await staticFindings(
    page('div{text-transform:uppercase}', `<div><span>${LONG_COPY}</span></div>`),
    'all-caps-body'
  );
  assert.deepEqual(found, [`text-transform: uppercase on ${LONG_COPY.length} chars of body text`]);
});

// --- the excluded elements themselves ----------------------------------------
//
// The exclusions these cases widen already covered the named element. Pinning
// that keeps a widening from being read as a rewrite.

test('a sub is not reported at the size the default sheet gives it', async () => {
  const found = await staticFindings(
    page('', `<div style="font-size:14px"><sub>${SHORT_COPY}</sub></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('a heading is not reported at the leading it sets', async () => {
  const found = await staticFindings(
    page('h2{line-height:1.1}', `<h2>${LONG_COPY}</h2>`),
    'tight-leading'
  );
  assert.deepEqual(found, []);
});

test('a heading is not reported for the case it sets', async () => {
  const found = await staticFindings(
    page('h2{text-transform:uppercase}', `<h2>${LONG_COPY}</h2>`),
    'all-caps-body'
  );
  assert.deepEqual(found, []);
});

// --- the colour checks, which stay element-keyed ------------------------------
//
// Both rows are today's behaviour and neither moves in this change. They are
// here because the difference between them is what the ruling on that rule
// turns on: the second is a real contrast failure that any ancestor-aware
// reading of `SAFE_TAGS` would silence, since every element on a page has
// `<body>` above it and `<body>` is in that set.

test('text inside a coloured link is still reported for the contrast it inherits', async () => {
  const found = await staticFindings(
    page('body{background:#ffffff}a{color:#bbbbbb}', `<a href="#"><p>${SHORT_COPY}</p></a>`),
    'low-contrast'
  );
  assert.deepEqual(found, ['1.9:1 (need 4.5:1) — text #bbbbbb on #ffffff']);
});

test('text inheriting its colour from the body is still reported for contrast', async () => {
  const found = await staticFindings(
    page('body{background:#ffffff;color:#bbbbbb}', `<p>${SHORT_COPY}</p>`),
    'low-contrast'
  );
  assert.deepEqual(found, ['1.9:1 (need 4.5:1) — text #bbbbbb on #ffffff']);
});
