/**
 * A `padding`/`margin` declaration written in `rem`, as the monotonous-spacing
 * rule reads it on each engine.
 *
 * The rule is emitted from two independent implementations — the helper in
 * `rules/checks.mjs`, reached by the static-HTML engine, and the regex engine's
 * own analyzer — and each used to carry its own root-font-size constant and its
 * own declaration pattern. A page priced differently by each is a divergence
 * between them, so the reduction and the pattern live in the shared length
 * module once and both engines call it. These cases are what says so: they
 * assert the same page reads the same on both, and they are the only cases in
 * the tree that read a spacing declaration in `rem` at all.
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
import { detectText } from './engines/regex/detect-text.mjs';

const RULE = 'monotonous-spacing';

/**
 * A full page, since both engines' page-level analyzers refuse anything without
 * a doctype, an `<html>` and a `<head>`. The `<img src="">` is an engine control
 * rather than decoration: it makes both engines emit `broken-image` on every
 * page here, so a silent verdict is a silent rule and not an engine that never
 * ran.
 *
 * @param {string} style
 */
function page(style) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title>
<style>${style}</style></head>
<body><p>x</p><img src=""></body></html>`;
}

/** The engine control: the finding every page here produces from both engines. */
const CONTROL = 'broken-image';

/**
 * Ten `padding`/`margin` declarations across every longhand the pattern admits,
 * all at one rem value — the rule needs at least ten spacing values before it
 * reports, and one dominant value before it reports monotony.
 */
const TEN_REM_DECLARATIONS =
  '.a{padding:1rem}.b{margin:1rem}.c{padding-top:1rem}.d{margin-left:1rem}' +
  '.e{padding:1rem}.f{margin:1rem}.g{padding-bottom:1rem}.h{margin-right:1rem}' +
  '.i{padding:1rem}.j{margin:1rem}';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-rem-spacing-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/**
 * Run one page through both engines and return each one's monotonous-spacing
 * snippets.
 *
 * @param {string} html
 */
async function bothEngines(html) {
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(file, html, 'utf-8');
  const fromStatic = await detectHtml(file, {});
  const fromRegex = detectText(html, file, {});
  assert.ok(
    fromStatic.some((f) => f.antipattern === CONTROL),
    'engine control: the static-HTML engine must have run on this page'
  );
  assert.ok(
    fromRegex.some((f) => f.antipattern === CONTROL),
    'engine control: the regex engine must have run on this page'
  );
  return {
    static: fromStatic.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
    regex: fromRegex.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
  };
}

test('the static engine prices a spacing declaration written in rem against the root font size', async () => {
  const found = await bothEngines(page(`${TEN_REM_DECLARATIONS}.k{padding-left:1rem}`));
  assert.deepEqual(found.static, ['~16px used 11/11 times (100%)']);
});

test('the regex engine prices a spacing declaration written in rem against the root font size', async () => {
  const found = await bothEngines(page(`${TEN_REM_DECLARATIONS}.k{padding-left:1rem}`));
  assert.deepEqual(found.regex, ['~16px used 11/11 times (100%)']);
});

test('both engines price a spacing declaration written in rem the same', async () => {
  const found = await bothEngines(page(`${TEN_REM_DECLARATIONS}.k{padding-left:2.5rem}`));
  assert.deepEqual(found.static, found.regex);
  assert.deepEqual(found.static, ['~16px used 10/11 times (91%)']);
});

test('a rem spacing value above the spacing bound is priced by neither engine', async () => {
  const found = await bothEngines(page(`${TEN_REM_DECLARATIONS}.k{padding-left:20rem}`));
  assert.deepEqual(found.static, ['~16px used 10/10 times (100%)']);
  assert.deepEqual(found.regex, ['~16px used 10/10 times (100%)']);
});

test('a zero rem spacing value is priced by neither engine', async () => {
  const found = await bothEngines(page(`${TEN_REM_DECLARATIONS}.k{padding-left:0rem}`));
  assert.deepEqual(found.static, ['~16px used 10/10 times (100%)']);
  assert.deepEqual(found.regex, ['~16px used 10/10 times (100%)']);
});
