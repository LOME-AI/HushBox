/**
 * The verdicts both analysis engines reach from the same raw source text.
 *
 * Each of these used to exist once per engine, so these cases are written twice
 * over: once against the shared verdict directly, and once through both engines
 * on one page, asserting they answer the same. The second half is what a second
 * copy would break — a unit case over one definition cannot notice that a
 * caller stopped using it.
 *
 * Every engine-driven case asserts the engine that answered. `detectHtml` falls
 * back to the regex engine and says nothing when its parser dependencies do not
 * resolve, so a case that does not read the stamp grades whichever engine
 * happened to run.
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

import { ENGINE_REGEX, ENGINE_STATIC_HTML } from './findings.mjs';
import { darkGlowVerdict, monotonousSpacingSnippet } from './shared/source-verdicts.mjs';
import { detectHtml } from './engines/static-html/detect-html.mjs';
import { detectText } from './engines/regex/detect-text.mjs';

// ---------------------------------------------------------------------------
// The monotonous-spacing verdict
// ---------------------------------------------------------------------------

/** @param {string} declaration @param {number} times */
function repeat(declaration, times) {
  return Array.from({ length: times }, (_, index) => `.r${index}{${declaration}}`).join('');
}

test('a source with fewer spacing values than the count floor is not monotonous', () => {
  assert.equal(monotonousSpacingSnippet(repeat('padding:16px', 9)), null);
});

test('a source at the count floor with one spacing value is monotonous', () => {
  assert.equal(
    monotonousSpacingSnippet(repeat('padding:16px', 10)),
    '~16px used 10/10 times (100%)'
  );
});

test('a spacing value is counted at the nearest step above a half step', () => {
  assert.equal(
    monotonousSpacingSnippet(repeat('padding:14px', 10)),
    '~16px used 10/10 times (100%)'
  );
});

test('a spacing value on a half step is counted at the step above it', () => {
  assert.equal(
    monotonousSpacingSnippet(repeat('padding:10px', 10)),
    '~12px used 10/10 times (100%)'
  );
});

test('a declared spacing at the bottom of the bound is counted by no scale', () => {
  assert.equal(monotonousSpacingSnippet(repeat('padding:0px', 10)), null);
});

test('a declared spacing at the top of the bound is counted by no scale', () => {
  assert.equal(monotonousSpacingSnippet(repeat('padding:200px', 10)), null);
});

test('a gap is counted at a value the bound refuses a declared spacing', () => {
  assert.equal(monotonousSpacingSnippet(repeat('gap:0px', 10)), '~0px used 10/10 times (100%)');
});

test('a utility class is counted at a value the bound refuses a declared spacing', () => {
  assert.equal(monotonousSpacingSnippet(repeat('gap-50', 10)), '~200px used 10/10 times (100%)');
});

test('a spacing declaration written in rem is counted against the root font size', () => {
  assert.equal(
    monotonousSpacingSnippet(repeat('padding:1rem', 10)),
    '~16px used 10/10 times (100%)'
  );
});

test('a dominant value at exactly the dominance floor is not monotonous', () => {
  const source = repeat('padding:16px', 6) + repeat('margin:20px', 2) + repeat('gap:24px', 2);
  assert.equal(monotonousSpacingSnippet(source), null);
});

test('a dominant value above the dominance floor is monotonous', () => {
  const source = repeat('padding:16px', 7) + repeat('margin:20px', 2) + repeat('gap:24px', 1);
  assert.equal(monotonousSpacingSnippet(source), '~16px used 7/10 times (70%)');
});

test('a source with more distinct values than the variety cap is not monotonous', () => {
  const source = repeat('padding:16px', 7) + '.a{margin:20px}.b{gap:24px}.c{padding:28px}';
  assert.equal(monotonousSpacingSnippet(source), null);
});

test('two equally dominant spacing values are monotonous on no ordering of them', () => {
  // The verdict's inputs used to be collected in a different order by each
  // engine, and a tie at the maximum is the only place that could show: with
  // two values tied at the top the total is at least twice the maximum, so
  // dominance cannot exceed half and the dominance floor refuses it first.
  assert.equal(monotonousSpacingSnippet(repeat('padding:16px', 5) + repeat('gap:20px', 5)), null);
  assert.equal(monotonousSpacingSnippet(repeat('gap:20px', 5) + repeat('padding:16px', 5)), null);
});

test('the monotonous-spacing verdict is the same on a second reading of one source', () => {
  const source = repeat('padding:16px', 10);
  assert.equal(monotonousSpacingSnippet(source), monotonousSpacingSnippet(source));
});

// ---------------------------------------------------------------------------
// The dark-glow verdict
// ---------------------------------------------------------------------------

const COLORED_GLOW = '.g{box-shadow:0 0 20px rgba(139,92,246,0.5)}';

test('a colored glow on a page with no dark background is no dark glow', () => {
  assert.equal(darkGlowVerdict(`.p{background:#ffffff}${COLORED_GLOW}`), null);
});

test('a colored glow on a dark background is a dark glow', () => {
  const verdict = darkGlowVerdict(`.p{background:#111111}${COLORED_GLOW}`);
  assert.equal(verdict?.snippet, 'Colored glow (rgb(139,92,246)) on dark page');
});

test('a colored glow on a dark background stated by a utility class is a dark glow', () => {
  const verdict = darkGlowVerdict(`<div class="bg-slate-900"></div><style>${COLORED_GLOW}</style>`);
  assert.equal(verdict?.snippet, 'Colored glow (rgb(139,92,246)) on dark page');
});

test('a grey glow on a dark background is no dark glow', () => {
  assert.equal(
    darkGlowVerdict('.p{background:#111111}.g{box-shadow:0 0 20px rgba(100,100,100,0.5)}'),
    null
  );
});

test('a colored shadow at the blur bound is no dark glow', () => {
  assert.equal(
    darkGlowVerdict('.p{background:#111111}.g{box-shadow:0 0 4px rgba(139,92,246,0.5)}'),
    null
  );
});

test('a colored shadow above the blur bound is a dark glow', () => {
  const verdict = darkGlowVerdict(
    '.p{background:#111111}.g{box-shadow:0 0 5px rgba(139,92,246,0.5)}'
  );
  assert.equal(verdict?.snippet, 'Colored glow (rgb(139,92,246)) on dark page');
});

test('the dark-glow verdict reports where in the source the shadow was written', () => {
  const source = `.p{background:#111111}\n\n${COLORED_GLOW}`;
  const verdict = darkGlowVerdict(source);
  assert.equal(source.slice(0, verdict?.index).split('\n').length, 3);
});

test('the dark-glow verdict is the same on a second reading of one source', () => {
  const source = `.p{background:#111111}${COLORED_GLOW}`;
  assert.deepEqual(darkGlowVerdict(source), darkGlowVerdict(source));
});

// ---------------------------------------------------------------------------
// Both engines, one page
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-source-verdicts-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/**
 * One page as both engines read it. The `<img src="">` is the engine control:
 * both engines report `broken-image` on it, so a silent verdict is a silent
 * rule rather than an engine that never ran.
 *
 * @param {string} style
 * @param {string} rule
 */
async function bothEngines(style, rule) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title>
<style>${style}</style></head>
<body><p>x</p><img src=""></body></html>`;
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const fromStatic = await detectHtml(file, {});
  const fromRegex = detectText(html, file, {});
  assert.deepEqual(
    [...new Set(fromStatic.map((f) => f.engine))],
    [ENGINE_STATIC_HTML],
    'engine control: the static-HTML engine must be the one that answered'
  );
  assert.deepEqual(
    [...new Set(fromRegex.map((f) => f.engine))],
    [ENGINE_REGEX],
    'engine control: the regex engine must be the one that answered'
  );
  return {
    static: fromStatic.filter((f) => f.antipattern === rule).map((f) => f.snippet),
    regex: fromRegex.filter((f) => f.antipattern === rule).map((f) => f.snippet),
  };
}

test('both engines reach the same monotonous-spacing verdict on one page', async () => {
  const found = await bothEngines(
    repeat('padding:16px', 7) + repeat('margin:20px', 3),
    'monotonous-spacing'
  );
  assert.deepEqual(found.static, ['~16px used 7/10 times (70%)']);
  assert.deepEqual(found.regex, found.static);
});

test('both engines refuse the same page below the dominance floor', async () => {
  const found = await bothEngines(
    repeat('padding:16px', 6) + repeat('margin:20px', 4),
    'monotonous-spacing'
  );
  assert.deepEqual(found.static, []);
  assert.deepEqual(found.regex, []);
});

test('both engines reach the same dark-glow verdict on one page', async () => {
  const found = await bothEngines(`.p{background:#111111}${COLORED_GLOW}`, 'dark-glow');
  assert.deepEqual(found.static, ['Colored glow (rgb(139,92,246)) on dark page']);
  assert.deepEqual(found.regex, found.static);
});

test('both engines refuse the same page a grey glow', async () => {
  const found = await bothEngines(
    '.p{background:#111111}.g{box-shadow:0 0 20px rgba(100,100,100,0.5)}',
    'dark-glow'
  );
  assert.deepEqual(found.static, []);
  assert.deepEqual(found.regex, []);
});
