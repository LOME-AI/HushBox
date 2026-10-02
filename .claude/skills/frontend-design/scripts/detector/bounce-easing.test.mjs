/**
 * `bounce-easing` over the source text that states it, from the two readings
 * that read the same characters with the same patterns.
 *
 * The regex engine's matchers and `checkHtmlPatterns` in `rules/checks.mjs`
 * carry byte-identical patterns for a bounce animation name and for an
 * overshoot `cubic-bezier`, and reported different SETS from them: the matchers
 * run per line and report every match, where `checkHtmlPatterns` reported the
 * first and stopped. On a source stating four, that is four findings against
 * two. Which shape is right is a decision about what the detector says, and it
 * is settled here: every match, because each declaration is a separate place a
 * reader has to change, and a report naming one of four leaves three that
 * nothing points at.
 *
 * The third reader is {@link checkMotion}, which reads the curves an element
 * resolves to rather than the text a source states, and it is the static-HTML
 * engine's only live reader of this rule: that engine drops the whole of
 * `checkHtmlPatterns`'s bounce reading in favour of what its element rules reach
 * off a resolved cascade, the same disposition `layout-transition` carries. It
 * gives the same answer over the population it can see — every overshoot curve
 * the element carries — and it counts one curve once however many properties
 * state it. The value it reads is the element's animation timing and its
 * transition timing joined into one string by that reader itself, so a second
 * match in the join is an artifact of the join and not a second fact, and a
 * report carrying no line and no property name has nothing to tell two such
 * rows apart with.
 *
 * THE FOURTH INPUT is `animate-bounce`, a Tailwind class rather than a
 * declaration: the regex engine reads it off a source line and
 * {@link checkMotion} reads it off an element's class list, while
 * `checkHtmlPatterns` reads declarations only and never covered it. The element
 * reading could not either — its call site handed it an empty class list — so a
 * registered verdict had no static-HTML path at all, and the cases at the foot
 * of this file are what say it does now.
 *
 * WHAT IS NOT PINNED HERE, and why. A page whose stylesheet states a bounce that
 * no element carries is four findings from the regex engine and none from the
 * static one. That is two readers of different inputs rather than two copies of
 * one reader, and it is not what these cases decide.
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
import { detectText } from './engines/regex/detect-text.mjs';
import { detectHtml } from './engines/static-html/detect-html.mjs';
import { checkHtmlPatterns } from './rules/checks.mjs';

const RULE = 'bounce-easing';

/** A declaration every source here carries, so a silent verdict is a silent
 *  rule rather than a reader that never ran. */
const CONTROL = '.control{animation:bounce-in 1s}';

/** The control's own snippet, which both readings report and neither case asserts. */
const CONTROL_SNIPPET = 'animation: bounce-in';

/** @param {string} css */
function fromRegexEngine(css) {
  const findings = detectText(`<style>${CONTROL}\n${css}</style>`, 'motion.html', {});
  assert.deepEqual(
    [...new Set(findings.map((f) => f.engine))],
    [ENGINE_REGEX],
    'engine control: the regex engine must be the one that answered'
  );
  const reported = findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet);
  assert.ok(reported.includes(CONTROL_SNIPPET), 'engine control: the control declaration must report');
  return reported.filter((snippet) => snippet !== CONTROL_SNIPPET);
}

/** @param {string} css */
function fromHtmlPatterns(css) {
  const reported = checkHtmlPatterns(`<style>${CONTROL}\n${css}</style>`)
    .filter((f) => f.id === RULE)
    .map((f) => f.snippet);
  assert.ok(reported.includes(CONTROL_SNIPPET), 'reader control: the control declaration must report');
  return reported.filter((snippet) => snippet !== CONTROL_SNIPPET);
}

const THREE_ANIMATIONS =
  '.a{animation:elastic-in 1s}\n.b{animation-name:wobble}\n.c{animation:jiggle 2s}';

const TWO_OVERSHOOTS =
  '.d{transition-timing-function:cubic-bezier(0.34, 1.56, 0.64, 1)}\n' +
  '.e{animation-timing-function:cubic-bezier(0.5, -0.6, 0.7, 1)}';

test('every bounce animation a source states is reported by the source-text reading', () => {
  assert.deepEqual(fromHtmlPatterns(THREE_ANIMATIONS), [
    'animation: elastic-in',
    'animation: wobble',
    'animation: jiggle',
  ]);
});

test('every overshoot easing curve a source states is reported by the source-text reading', () => {
  assert.deepEqual(fromHtmlPatterns(TWO_OVERSHOOTS), [
    'cubic-bezier(0.34, 1.56, 0.64, 1)',
    'cubic-bezier(0.5, -0.6, 0.7, 1)',
  ]);
});

test('the two readings of one source report the same bounce animations', () => {
  assert.deepEqual(fromHtmlPatterns(THREE_ANIMATIONS).sort(), fromRegexEngine(THREE_ANIMATIONS).sort());
});

test('the two readings of one source report the same overshoot easing curves', () => {
  assert.deepEqual(fromHtmlPatterns(TWO_OVERSHOOTS).sort(), fromRegexEngine(TWO_OVERSHOOTS).sort());
});

// The bound the every-match shape must not spend: a curve inside the unit
// square overshoots nothing, and reporting every match would be reporting every
// easing curve on the page.
test('an easing curve that overshoots nothing is reported by neither reading', () => {
  const css = '.f{transition-timing-function:cubic-bezier(0.4, 0, 0.2, 1)}';
  assert.deepEqual(fromHtmlPatterns(css), []);
  assert.deepEqual(fromRegexEngine(css), []);
});

// ─── The reading that resolves an element ────────────────────────────────────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-bounce-easing-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** The element every page here carries, so a silent verdict is a silent rule
 *  rather than an engine that never ran. */
const ELEMENT_CONTROL = '<div style="animation:bounce-in 1s">c</div>';

/** The control element's own snippet, which no case below asserts. */
const ELEMENT_CONTROL_SNIPPET = 'animation: bounce-in';

let caseCount = 0;

/**
 * The curves the static-HTML engine reports for one page, less the control's.
 * The engine stamp is asserted because this engine loads its parsers by bare
 * specifier and falls back to the regex engine without an error when they do
 * not resolve, which would answer this question as the wrong reader.
 * @param {string} body
 */
async function fromElementReading(body) {
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(
    file,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body>${ELEMENT_CONTROL}${body}</body></html>`,
    'utf8'
  );
  const findings = await detectHtml(file, {});
  assert.deepEqual(
    [...new Set(findings.map((f) => f.engine))],
    [ENGINE_STATIC_HTML],
    'engine control: the static-HTML engine must be the one that answered'
  );
  const reported = findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet);
  assert.ok(
    reported.includes(ELEMENT_CONTROL_SNIPPET),
    'engine control: the control element must report'
  );
  return reported.filter((snippet) => snippet !== ELEMENT_CONTROL_SNIPPET);
}

test('every overshoot easing curve an element carries is reported by the element reading', async () => {
  assert.deepEqual(
    await fromElementReading(
      '<div style="animation-timing-function:cubic-bezier(0.34, 1.56, 0.64, 1);' +
        'transition-timing-function:cubic-bezier(0.5, -0.6, 0.7, 1)">x</div>'
    ),
    ['cubic-bezier(0.34, 1.56, 0.64, 1)', 'cubic-bezier(0.5, -0.6, 0.7, 1)']
  );
});

// The decision the every-curve shape forces, and the bound it is held to: the
// element carries one curve, stated on two of its properties, and the reader
// that sees both states sees it in a string it built by joining them. One
// curve, one row — the reader has no line and no property name to make a second
// row mean anything with.
test('an element stating one overshoot easing curve on two properties is reported once', async () => {
  assert.deepEqual(
    await fromElementReading(
      '<div style="animation-timing-function:cubic-bezier(0.34, 1.56, 0.64, 1);' +
        'transition-timing-function:cubic-bezier(0.34, 1.56, 0.64, 1)">x</div>'
    ),
    ['cubic-bezier(0.34, 1.56, 0.64, 1)']
  );
});

test('an easing curve that overshoots nothing is reported by no reading', async () => {
  assert.deepEqual(
    await fromElementReading(
      '<div style="transition-timing-function:cubic-bezier(0.4, 0, 0.2, 1)">x</div>'
    ),
    []
  );
});

// ─── The utility class, which the element reading could not see ──────────────
//
// `animate-bounce` names a bounce the element carries rather than a declaration
// the source states, so `checkHtmlPatterns` — which reads declarations — never
// covered it, and the element reading was handed an empty class list by its own
// call site and could not either. The static engine therefore answered nothing
// on a class the regex engine has always reported.

test('a bounce utility class on an element is reported by the element reading', async () => {
  assert.deepEqual(
    await fromElementReading('<div class="animate-bounce">x</div>'),
    ['animate-bounce (Tailwind)']
  );
});

test('the two readings report the same bounce utility class', () => {
  const findings = detectText(
    `<style>${CONTROL}</style>\n<div class="animate-bounce">x</div>`,
    'motion.html',
    {}
  );
  assert.deepEqual(
    [...new Set(findings.map((f) => f.engine))],
    [ENGINE_REGEX],
    'engine control: the regex engine must be the one that answered'
  );
  const reported = findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet);
  assert.ok(reported.includes(CONTROL_SNIPPET), 'engine control: the control declaration must report');
  assert.deepEqual(
    reported.filter((snippet) => snippet !== CONTROL_SNIPPET),
    ['animate-bounce (Tailwind)']
  );
});
