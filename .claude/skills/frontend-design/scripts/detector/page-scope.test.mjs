/**
 * Which findings the page gate holds back, and which it lets through.
 *
 * The gate admits only a source carrying a doctype, an `<html>` or a `<head>`,
 * which is a shape no component file has. Behind it sat rules that read a single
 * element and answer the same on any markup — so the same declaration reported
 * on a `.css` component and was silent on an `.html` one. What belongs behind
 * the gate is only a claim about the document as a whole: the fonts it settles
 * on, its spacing rhythm, its heading outline. A fragment of a larger page can
 * answer one of those differently from the page it came from; it cannot answer
 * an element-side one differently.
 *
 * Each case here drives the same markup twice — once as a component source and
 * once wrapped in a page shell — because the asymmetry between the two is the
 * defect, and only the pair shows it closing.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Nothing else
 * reaches them — `.claude/**` is outside every workspace glob, so no vitest
 * project and no ESLint config sees them. Run them on their own with
 * `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectHtml } from './engines/static-html/detect-html.mjs';
import { REGEX_ANALYZERS, detectText, runTextContentAnalyzers } from './engines/regex/detect-text.mjs';
import { SCOPE_DOCUMENT } from './shared/page.mjs';

/** The finding every source here produces, so a silent rule is not a silent engine. */
const CONTROL = 'broken-image';

/** The control's markup: an `<img>` with an empty `src`. */
const CONTROL_MARKUP = '<img src="">';

/**
 * A component-shaped source: markup with no doctype, no `<html>` and no
 * `<head>`, which is the shape the page gate refuses.
 * @param {string} body
 */
function fragment(body) {
  return `${body}${CONTROL_MARKUP}`;
}

/**
 * The same markup as a page: the fragment inside a shell carrying all three of
 * the tells the gate reads.
 * @param {string} body
 */
function page(body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body>${body}${CONTROL_MARKUP}</body></html>`;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-page-scope-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/**
 * Run one source through the static-HTML engine and return the snippets it
 * reported for one rule. The engine control is asserted first, so a rule that
 * reports nothing is distinguishable from an engine that never ran — which is
 * the failure this engine has, silently, when its parser dependencies are
 * missing and it falls back to the regex engine.
 * @param {string} html
 * @param {string} rule
 * @param {readonly string[]} [providers]
 */
async function snippets(html, rule, providers = []) {
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const findings = await detectHtml(file, { providers });
  assert.ok(
    findings.some((f) => f.antipattern === CONTROL && f.engine === 'static-html'),
    'engine control: the static-HTML engine must have run on this source'
  );
  return findings.filter((f) => f.antipattern === rule).map((f) => f.snippet);
}

/**
 * Drive one rule over the same markup as a component source and as a page, and
 * return both readings.
 * @param {string} rule
 * @param {string} body
 * @param {readonly string[]} [providers]
 */
async function bothShapes(rule, body, providers) {
  return {
    component: await snippets(fragment(body), rule, providers),
    page: await snippets(page(body), rule, providers),
  };
}

// ─── Element-side rules: the same answer whatever shape the source has ───────

test('the overused-font rule reads a component source the same as the page wrapping it', async () => {
  const { component, page: whole } = await bothShapes(
    'overused-font',
    `<style>.card p { font-family: 'Inter', sans-serif; }</style>
     <div class="card"><p>Body copy set in the overused face.</p></div>`
  );
  assert.deepEqual(component, ['Primary font: inter']);
  assert.deepEqual(component, whole);
});

test('the image-hover-transform rule reads a component source the same as the page wrapping it', async () => {
  const { component, page: whole } = await bothShapes(
    'image-hover-transform',
    `<style>img.thumb:hover { transform: scale(1.05); }</style>
     <div class="tile"><img class="thumb" src="/thumb.png" alt="A thumbnail"></div>`,
    ['gemini']
  );
  assert.deepEqual(component, ['img:hover { transform } rule']);
  assert.deepEqual(component, whole);
});

test('the repeating-stripes-gradient rule reads a component source the same as the page wrapping it', async () => {
  const { component, page: whole } = await bothShapes(
    'repeating-stripes-gradient',
    `<div style="background: repeating-linear-gradient(45deg, #eee 0 10px, #fff 10px 20px)">Striped panel.</div>`,
    ['gpt']
  );
  assert.deepEqual(component, ['repeating-gradient decorative stripes']);
  assert.deepEqual(component, whole);
});

test('the nested-cards rule reads a component source the same as the page wrapping it', async () => {
  const { component, page: whole } = await bothShapes(
    'nested-cards',
    `<div class="border rounded bg-white"><div class="border rounded bg-white">Inner card body copy.</div></div>`
  );
  assert.deepEqual(component, ['Card inside card (div)']);
  assert.deepEqual(component, whole);
});

test('a verdict that declares no page scope reads a component source the same as the page wrapping it', async () => {
  const { component, page: whole } = await bothShapes(
    'theater-slop-phrase',
    '<p>The release turned into a deployment theater nobody asked for.</p>',
    ['gpt']
  );
  assert.deepEqual(component, ['"deployment theater"']);
  assert.deepEqual(component, whole);
});

// ─── Document-side rules: a claim a fragment of a page cannot answer ─────────

test('the single-font rule is refused a component source', async () => {
  const paragraphs = Array.from(
    { length: 24 },
    (_, index) => `<p>Paragraph ${index} of the copy.</p>`
  );
  const body = `<style>* { font-family: 'Fraunces', serif; }</style>${paragraphs.join('')}`;
  const { component, page: whole } = await bothShapes('single-font', body);
  assert.deepEqual(whole, ['only font used is fraunces']);
  assert.deepEqual(component, []);
});

test('the monotonous-spacing rule is refused a component source', async () => {
  const rules = Array.from({ length: 12 }, (_, index) => `.pad-${index} { padding: 16px; }`);
  const body = `<style>${rules.join('')}</style><div class="pad-0">Spacing sample.</div>`;
  const { component, page: whole } = await bothShapes('monotonous-spacing', body);
  assert.deepEqual(whole, ['~16px used 12/12 times (100%)']);
  assert.deepEqual(component, []);
});

test('the skipped-heading rule is refused a component source', async () => {
  const body = '<h1>Title</h1><h3>Jumped a level</h3>';
  const { component, page: whole } = await bothShapes('skipped-heading', body);
  assert.deepEqual(whole, ['<h1> "Title" followed by <h3> "Jumped a level" (missing h2)']);
  assert.deepEqual(component, []);
});

// ─── The verdicts that judge copy, which reached the gate from another file ──
//
// `em-dash-overuse`, `marketing-buzzword`, `numbered-section-markers` and
// `aphoristic-cadence` each read a whole source's body copy and count what it
// states — a claim about the document, answerable differently by a fragment cut
// out of it, exactly like the fonts a page settles on. They were silent on a
// component source because a second gate in the regex engine held them, so the
// filter here neither saw them nor spoke for them. They declare their scope now
// and pass through this one, which is what these cases drive: the declaration
// each verdict carries, and the answer the gate gives on both source shapes.

/** Copy that trips all four of the text-content analyzers at once. */
const COPY = `<p>01 Discovery — the first step — is where teams stall — every time — and it shows —.</p>
<p>02 Delivery. Not a framework. Something better.</p>
<p>03 Scale. Not a promise. A measurement.</p>
<p>04 Support. Not an add-on. The product.</p>
<p>We supercharge your workflow with best-in-class tooling.</p>`;

const COPY_VERDICTS = [
  'aphoristic-cadence',
  'em-dash-overuse',
  'marketing-buzzword',
  'numbered-section-markers',
];

/** @param {readonly import('./findings.mjs').Finding[]} findings */
const ids = (findings) => findings.map((f) => f.antipattern).sort();

test('every verdict this engine reaches about a whole page declares the scope that gates it', () => {
  const scopes = REGEX_ANALYZERS.flatMap((analyzer) => analyzer(page(COPY), 'copy.html')).map(
    (f) => `${f.antipattern}: ${f.scope}`
  );
  assert.ok(scopes.length > 0, 'control: the page analyzers must have reached a verdict');
  assert.deepEqual(
    scopes.filter((entry) => !entry.endsWith(`: ${SCOPE_DOCUMENT}`)),
    []
  );
});

test('a verdict that judges a page\'s copy is refused a component source', () => {
  assert.deepEqual(ids(runTextContentAnalyzers(fragment(COPY), 'copy.html')), []);
});

test('a verdict that judges a page\'s copy is reported on a page', () => {
  assert.deepEqual(ids(runTextContentAnalyzers(page(COPY), 'copy.html')), COPY_VERDICTS);
});

test('a verdict that judges a page\'s copy carries no scope key into the report', () => {
  for (const reported of runTextContentAnalyzers(page(COPY), 'copy.html')) {
    assert.equal(Object.hasOwn(reported, 'scope'), false);
  }
});

// ─── The other predicate, which is not this gate and is not one either ───────
//
// A `.ts` or `.tsx` file that writes a whole page into a string carries every
// character the page gate reads, so the gate admits it and the four copy
// verdicts would judge it. What stops them is a different property of the
// source: whether its text is copy a reader sees at all, or the program text of
// a file that happens to write markup out. Measured over this repository, 53
// sources are page-shaped by their characters alone, and reading their text as
// copy reports the em-dashes in their code comments and the ordinals in a debug
// script — 16 rows, every one of them wrong.
//
// The pair below is the same bytes under two file names, which is the only
// shape that shows the file's type is what decides them: the page gate cannot
// tell the two apart, because the characters are identical.

/** A finding the regex engine reports on both sources, so a silent verdict is a
 *  silent rule rather than an engine that never read the file. */
const REGEX_CONTROL = 'broken-image';

/** @param {string} filePath */
function copyVerdictsFromRegexEngine(filePath) {
  const findings = detectText(page(COPY), filePath, {});
  assert.ok(
    findings.some((f) => f.antipattern === REGEX_CONTROL),
    'engine control: the regex engine must have read this source'
  );
  return ids(findings.filter((f) => COPY_VERDICTS.includes(f.antipattern)));
}

test('a verdict that judges a page\'s copy is refused a source that only writes a page out', () => {
  assert.deepEqual(copyVerdictsFromRegexEngine('page.tsx'), []);
});

test('a verdict that judges a page\'s copy is reported on the same bytes named as markup', () => {
  assert.deepEqual(copyVerdictsFromRegexEngine('page.html'), COPY_VERDICTS);
});
