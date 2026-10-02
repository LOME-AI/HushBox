/**
 * The text a source's body states, as every rule that judges copy reads it.
 *
 * Two implementations of one intent stood here: the strip the regex engine's
 * text-content analyzers read through, and a second one written inside
 * `checkHtmlPatterns` for `theater-slop-phrase`. They agreed on script, on style
 * and on tags, and disagreed on the two things a browser is decisive about — an
 * HTML comment is not text a reader sees, and a run of whitespace in normal
 * flow renders as one space. A phrase written across a line break came back
 * carrying the break and the indent that followed it, and a phrase written
 * inside a comment past a `>` was read as copy.
 *
 * The browser settles both, so neither was a matter of taste: `innerText` of a
 * body drops comments outright and collapses whitespace, and that is the
 * reading kept. One implementation now, in `shared/page.mjs`, and these cases
 * drive it from both of the rules that read it.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Run them on
 * their own with `node --test` and an explicit file list; a bare directory
 * argument is an invocation error, not a red suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { detectText } from './engines/regex/detect-text.mjs';
import { checkHtmlPatterns } from './rules/checks.mjs';

/**
 * A declaration every page here carries, so a silent verdict is a silent rule
 * rather than a reader that never ran. Both readers below report it: the
 * source-text reader as `repeating-stripes-gradient`, the regex engine as
 * `broken-image` off the `<img>` beside it.
 */
const CONTROL_MARKUP =
  '<div style="background:repeating-linear-gradient(45deg,#eee 0 10px,#fff 10px 20px)">x</div><img src="">';

/** @param {string} body */
function page(body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body>${body}${CONTROL_MARKUP}</body></html>`;
}

/** The phrase `theater-slop-phrase` reads, as `checkHtmlPatterns` reports it. */
/** @param {string} body */
function theaterSnippets(body) {
  const findings = checkHtmlPatterns(page(body));
  assert.ok(
    findings.some((f) => f.id === 'repeating-stripes-gradient'),
    'reader control: the source-text reader must have run on this page'
  );
  return findings.filter((f) => f.id === 'theater-slop-phrase').map((f) => f.snippet);
}

/** The em-dashes the regex engine's text-content analyzer counts. */
/** @param {string} body */
function emDashSnippets(body) {
  const source = page(body);
  const findings = detectText(source, 'copy.html', {});
  assert.ok(
    findings.some((f) => f.antipattern === 'broken-image'),
    'engine control: the regex engine must have run on this page'
  );
  return findings.filter((f) => f.antipattern === 'em-dash-overuse').map((f) => f.snippet);
}

test('a phrase written inside a comment is not body text for the phrase rule', () => {
  assert.deepEqual(theaterSnippets('<!-- 3 > 2, and security theater is why --><p>Plain copy.</p>'), []);
});

test('a phrase written inside a comment is not body text for the text-content analyzers', () => {
  assert.deepEqual(emDashSnippets('<!-- 3 > 2 — — — — — --><p>Plain copy.</p>'), []);
});

test('a phrase broken across a line reads as the one phrase a browser renders', () => {
  assert.deepEqual(
    theaterSnippets('<p>The release turned into a compliance\n        theater nobody asked for.</p>'),
    ['"compliance theater"']
  );
});

test('a phrase written inside a script is body text for neither reader', () => {
  assert.deepEqual(theaterSnippets('<script>const s = "security theater";</script><p>Copy.</p>'), []);
  assert.deepEqual(emDashSnippets('<script>const s = "— — — — —";</script><p>Copy.</p>'), []);
});

test('a phrase written in ordinary copy is read by the phrase rule', () => {
  assert.deepEqual(theaterSnippets('<p>The release turned into deployment theater.</p>'), [
    '"deployment theater"',
  ]);
});
