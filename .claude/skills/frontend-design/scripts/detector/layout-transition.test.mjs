/**
 * The `layout-transition` rule, over the two declarations that state one.
 *
 * `transition` and `transition-property` were read by two copies of one
 * matcher, and nothing in this tree pinned either: dropping the second matcher
 * outright, hard-coding the declaration the snippet names, and deleting the
 * `all` exclusion each left the whole suite green. These cases are what a
 * collapse of those two copies has to answer to.
 *
 * Every case asserts the engine that answered. Only the regex engine reports
 * this rule from source text — the static-HTML engine drops the copy its
 * `checkHtmlPatterns` computes, in favour of the verdict its element rules
 * reach off a resolved cascade.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Run them on
 * their own with `node --test` and an explicit file list; a bare directory
 * argument is an invocation error, not a red suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ENGINE_REGEX } from './findings.mjs';
import { detectText } from './engines/regex/detect-text.mjs';

/** A declaration every case carries, so a silent verdict is a silent rule
 *  rather than an engine that never ran. */
const CONTROL = '.control{transition:width 1s}';

/** @param {string} css */
function snippets(css) {
  const findings = detectText(`${CONTROL}\n${css}\n`, 'transitions.css', {});
  assert.deepEqual(
    [...new Set(findings.map((f) => f.engine))],
    [ENGINE_REGEX],
    'engine control: the regex engine must be the one that answered'
  );
  const reported = findings.filter((f) => f.antipattern === 'layout-transition');
  assert.ok(reported.length > 0, 'engine control: the control declaration must report');
  return reported.filter((f) => f.line > 1).map((f) => f.snippet);
}

test('a transition of a layout property is reported against the declaration that states it', () => {
  assert.deepEqual(snippets('.a{transition:height 1s}'), ['transition: height']);
});

test('a transition-property of a layout property names its own declaration back', () => {
  assert.deepEqual(snippets('.a{transition-property:height}'), ['transition-property: height']);
});

test('a transition of every property is reported against neither declaration', () => {
  assert.deepEqual(snippets('.a{transition:all 1s}'), []);
  assert.deepEqual(snippets('.a{transition-property:all}'), []);
});

// The case above is answered by the layout-property reading alone — `all` names
// none — so it says nothing about the exclusion. This one is the exclusion:
// drop it and both of these report.
test('a transition of every property is refused where it names a layout property beside it', () => {
  assert.deepEqual(snippets('.a{transition:all 1s, width 2s}'), []);
  assert.deepEqual(snippets('.a{transition-property:all,width}'), []);
});

test('a transition of a property costing no re-layout is reported against neither declaration', () => {
  assert.deepEqual(snippets('.a{transition:color 1s}'), []);
  assert.deepEqual(snippets('.a{transition-property:color}'), []);
});

test('a transition of a longhand is reported at the longhand its declaration names', () => {
  assert.deepEqual(snippets('.a{transition:padding-top 1s}'), ['transition: padding-top']);
  assert.deepEqual(snippets('.a{transition-property:margin-left}'), [
    'transition-property: margin-left',
  ]);
});

test('a transition of several layout properties lists every one of them back', () => {
  assert.deepEqual(snippets('.a{transition:width 1s, height 2s}'), ['transition: width, height']);
  assert.deepEqual(snippets('.a{transition-property:width,height}'), [
    'transition-property: width, height',
  ]);
});
