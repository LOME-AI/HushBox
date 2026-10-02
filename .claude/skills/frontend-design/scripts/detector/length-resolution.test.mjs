/**
 * How the detector prices a CSS length, and what each engine does with one it
 * cannot price.
 *
 * A font size in a unit the cascade cannot reduce to pixels — a viewport unit,
 * an absolute unit with no device to measure against — was priced as a multiple
 * of the parent size, so `font-size: 4vw` entered the size population at 64px
 * and a page that ships flat read as steep. The engine now reports that it
 * could not price the declaration rather than inventing a number for it, and
 * rather than dropping it: a page that says nothing about a size it could not
 * read is the same failure one step quieter.
 *
 * Both engines report a size they could not price, and they do not read the
 * same thing. The static-HTML engine reads a size its cascade resolved, so its
 * finding names what the page renders; the regex engine reads a declaration out
 * of source text with no cascade at all, so its finding names only the
 * declaration it saw. The second is the weaker reading, and it is the strongest
 * one available to an engine that never builds a document.
 *
 * The unitless multiple stays where it is the correct reading of the value.
 * `line-height: 1.2` genuinely is 1.2 times the element's own font size, so a
 * case here drives it end to end.
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

import { ENGINE_REGEX, ENGINE_STATIC_HTML } from './findings.mjs';
import { HTML_EXTENSIONS, SCANNABLE_EXTENSIONS } from './node/file-system.mjs';
import { NAME_SIGILS_BY_SOURCE_TYPE, detectText } from './engines/regex/detect-text.mjs';
import { detectHtml } from './engines/static-html/detect-html.mjs';

const RULE = 'unresolvable-font-size';

/** The finding every page here produces, so a silent rule is not a silent engine. */
const CONTROL = 'broken-image';

/**
 * A full page: the page-level analyzers refuse anything without a doctype, an
 * `<html>` and a `<head>`.
 */
/**
 * @param {string} style
 * @param {string} body
 */
function page(style, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title>
<style>${style}</style></head>
<body>${body}<img src=""></body></html>`;
}

/**
 * A component-shaped source: markup with no doctype, no `<html>` and no
 * `<head>`, which is the shape every page-level analyzer refuses. The element
 * rules run on it all the same, so a report that explains what an element rule
 * did must run on it too. The `<img src="">` is the engine control.
 */
/**
 * @param {string} style
 * @param {string} body
 */
function fragment(style, body) {
  return `<style>${style}</style>
${body}<img src="">`;
}

/** Text long enough to clear the length floor the body-text rules apply, so a
 *  case about a size can be driven through a rule that reads one. */
const LONG_BODY = 'A sentence long enough to clear the length floor the body-text rules apply.';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-length-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/** Run one page through the static-HTML engine and return all of its findings. */
/** @param {string} html */
async function staticEngine(html) {
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(file, html, 'utf-8');
  const findings = await detectHtml(file, {});
  assert.ok(
    findings.some((f) => f.antipattern === CONTROL),
    'engine control: the static-HTML engine must have run on this page'
  );
  return findings;
}

/** @param {string} html */
async function unresolvedSnippets(html) {
  return (await staticEngine(html)).filter((f) => f.antipattern === RULE).map((f) => f.snippet);
}

test('the static engine reports a font size in a viewport unit it cannot reduce', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('h1{font-size:4vw}h2{font-size:17px}p{font-size:16px}', '<h1>a</h1><h2>b</h2><p>c</p>')
    ),
    ['font-size: 4vw']
  );
});

test('the static engine reports a font size in an absolute unit it cannot reduce', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('h1{font-size:12pt}h2{font-size:17px}p{font-size:16px}', '<h1>a</h1><h2>b</h2><p>c</p>')
    ),
    ['font-size: 12pt']
  );
});

test('a page whose every font size reduces to px reports none', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page(
        'h1{font-size:2rem}h2{font-size:1.0625em}p{font-size:100%}',
        '<h1>a</h1><h2>b</h2><p>c</p>'
      )
    ),
    []
  );
});

test('a declaration the engine could not reduce is reported once however many elements carry it', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('h1,h2{font-size:4vw}p{font-size:16px}', '<h1>a</h1><h2>b</h2><p>c</p>')
    ),
    ['font-size: 4vw']
  );
});

test('each distinct declaration the engine could not reduce is reported', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('h1{font-size:4vw}h2{font-size:12pt}p{font-size:16px}', '<h1>a</h1><h2>b</h2><p>c</p>')
    ),
    ['font-size: 12pt', 'font-size: 4vw']
  );
});

// The interaction between the two rulings: a clamp() is priced at its minimum
// endpoint, which takes it out of the population this rule reports on. Were it
// still unresolvable, every clamp() page would carry this finding.
test('a clamp() font size reduces, so it is not reported unresolvable', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page(
        'h1{font-size:clamp(20px, 4vw, 30px)}h2{font-size:17px}p{font-size:16px}',
        '<h1>a</h1><h2>b</h2><p>c</p>'
      )
    ),
    []
  );
});

test('a font size the engine could not reduce is kept out of the size population', async () => {
  const findings = await staticEngine(
    page(
      'h1{font-size:4vw}h2{font-size:18px}p{font-size:17px}span{font-size:16px}',
      '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'flat-type-hierarchy').map((f) => f.snippet),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

// The contrast rule stands down on any element whose size the engine could not
// price, so the report that compensates is no narrower than that rule on any
// axis that narrows a population: the rule is registered on `*` and the report
// walks `*`, and the rule runs on every source this engine parses so the report
// runs on every one too. An element the report skips is one the source says
// nothing at all about, which is the fabricated size one step quieter rather
// than a refusal to invent one. Every tag below sits outside the text scan's own
// population and inside the contrast rule's: the same page at a priced size
// reports `low-contrast`.
for (const tag of ['strong', 'em', 'small', 'summary', 'figure', 'dt']) {
  test(`an unreducible size on a <${tag}> is reported, though the type scan does not read it`, async () => {
    const findings = await staticEngine(
      page(
        `body{background:#ffffff}${tag}{color:#8a8a8a;font-size:4vw}`,
        `<${tag}>Grey text on white</${tag}>`
      )
    );
    assert.deepEqual(
      findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
      ['font-size: 4vw']
    );
    assert.deepEqual(
      findings.filter((f) => f.antipattern === 'low-contrast').map((f) => f.snippet),
      []
    );
  });
}

// A size reaches an element either from its own declaration or from an ancestor's,
// so whatever a descendant carries, the element that stated the size is itself in
// the walk. Here the descendant is priced by a utility class and contributes
// nothing of its own, and the declaration is still on the page.
test('an unreducible size inherited past a class-priced element is still reported', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page(
        'body{background:#ffffff;font-size:4vw}strong{color:#8a8a8a}',
        '<strong class="text-lg">Grey text on white</strong>'
      )
    ),
    ['font-size: 4vw']
  );
});

// The element rules and the unresolvable-size report read one price for an element,
// so neither can hold a size the other does not. Here the cascade leaves the size
// this element inherits unreduced while the element states its own through a utility
// class: the report prices it at the class, and the contrast rule judges it at the
// same size rather than standing down on a size the page does state.
test('an element sized only by a utility class is judged by the contrast rule at the class size', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff;font-size:4vw}strong{color:#8a8a8a}',
      '<strong class="text-lg">Grey text on white</strong>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'low-contrast').map((f) => f.snippet),
    ['3.5:1 (need 4.5:1) — text #8a8a8a on #ffffff']
  );
});

// The same reading reaches every rule that takes a size off this element. The purple
// accent is called out on a heading or on text of 20px and up, and the only statement
// of this element's size is its class.
test('an element sized only by a utility class enters the accent-colour gate at the class size', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff}p{color:#7c3aed}',
      '<p class="text-3xl">Purple words here</p>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'ai-color-palette').map((f) => f.snippet),
    ['Purple/violet text (#7c3aed) on heading']
  );
});

// The boundary the class reading is bounded by, on both sides. A class states a size
// only where the cascade specified none, so a declared size outranks it and the
// element is judged at 12px; and a class that states a size under the gate leaves the
// element under it, so consulting the class is not a blanket pass.
test('a font size the page declares outranks a utility class at the accent-colour gate', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff}p{color:#7c3aed;font-size:12px}',
      '<p class="text-3xl">Purple words here</p>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'ai-color-palette').map((f) => f.snippet),
    []
  );
});

test('a utility class under the accent-colour gate leaves the element under it', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff}p{color:#7c3aed}',
      '<p class="text-xs">Purple words here</p>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'ai-color-palette').map((f) => f.snippet),
    []
  );
});

// Widening the report to the contrast rule's population must not widen the type
// scale with it: a size on an element the text scan never reads is not a step in
// the page's hierarchy, and counting it would change which pages read flat.
test('an element outside the text scan contributes no size to the type scale', async () => {
  const findings = await staticEngine(
    page(
      'p{font-size:16px}h2{font-size:20px}h1{font-size:24px}strong{font-size:40px}',
      '<h1>a</h1><h2>b</h2><p>c</p><strong>d</strong>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'flat-type-hierarchy').map((f) => f.snippet),
    ['Sizes: 16px, 20px, 24px (ratio 1.5:1)']
  );
});

// The same boundary on the other branch: a size a utility class states is read
// only where the cascade specified none, and an element the text scan never reads
// contributes that size to no hierarchy either.
test('a class-priced element outside the text scan contributes no size to the type scale', async () => {
  const findings = await staticEngine(
    page(
      'p{font-size:16px}h2{font-size:20px}h1{font-size:24px}',
      '<h1>a</h1><h2>b</h2><p>c</p><strong class="text-5xl">d</strong>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'flat-type-hierarchy').map((f) => f.snippet),
    ['Sizes: 16px, 20px, 24px (ratio 1.5:1)']
  );
});

test('the report of an unreducible font size carries the static-HTML engine stamp', async () => {
  const findings = await staticEngine(
    page('h1{font-size:4vw}h2{font-size:17px}p{font-size:16px}', '<h1>a</h1><h2>b</h2><p>c</p>')
  );
  const reported = findings.filter((f) => f.antipattern === RULE);
  assert.ok(reported.length > 0, 'positive control: the rule must have fired on this page');
  assert.deepEqual([...new Set(reported.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
});

// The fall-through the fix above must not take with it. `line-height: 1.2` is
// 1.2 times the element's own font size, and `tight-leading` is the rule that
// reads the resolved number: were the unitless reading gone the ratio would be
// zero and this page would go silent.
test('a unitless line-height still resolves to a multiple of the font size', async () => {
  const findings = await staticEngine(
    page(
      'p{font-size:16px;line-height:1.2}',
      '<p>A paragraph long enough that the leading rule looks at it at all, which takes more than fifty characters.</p>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'tight-leading').map((f) => f.snippet),
    ['line-height 1.20x (need >=1.3)']
  );
});

// Three element rules read the computed font size for themselves rather than
// through the strict reader, so an unreducible declaration reached them as the
// leading number of its own text: `4vw` arrived as 4px. Each of the cases below
// is red for its own rule when its own reader is the one left unstrict.
//
// `italic-serif-display` and the repeated-kicker collector GATE on a size, so a
// size the engine could not price stands in as the one the element inherits — a
// number the cascade actually produced. `low-contrast` does not gate: the size
// picks which of the two WCAG bars applies, so an unpriced size leaves the rule
// with the two verdicts no bar can change — a ratio under the lenient bar fails
// at every size, one over the strict bar fails at none — and nothing to say
// between them, which is what `unresolvable-font-size` reports on that element.

test('contrast under the lenient bar is reported for a heading whose size the engine cannot price', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff}h1{font-size:4vw;color:#a0a0a0;font-weight:700}',
      '<h1>Grey heading on white</h1>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'low-contrast').map((f) => f.snippet),
    ['2.6:1 (need 3:1) — text #a0a0a0 on #ffffff']
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
    ['font-size: 4vw']
  );
});

test('contrast over the strict bar is not reported for a heading whose size the engine cannot price', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff}h1{font-size:4vw;color:#666666;font-weight:700}',
      '<h1>Grey heading on white</h1>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'low-contrast').map((f) => f.snippet),
    []
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
    ['font-size: 4vw']
  );
});

test('contrast between the two bars is left to the unresolvable-size report', async () => {
  const findings = await staticEngine(
    page(
      'body{background:#ffffff}h1{font-size:4vw;color:#8a8a8a;font-weight:700}',
      '<h1>Grey heading on white</h1>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'low-contrast').map((f) => f.snippet),
    []
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
    ['font-size: 4vw']
  );
});

// The same stand-down on a component source. A component file carries no
// doctype, no `<html>` and no `<head>`, so every page-level analyzer refuses it
// — and the contrast rule is not one: it runs on the elements of whatever this
// engine parses. The report that says why it stood down is read off the same
// elements, so it runs wherever the contrast rule does rather than wherever the
// page rules do.
test('contrast between the two bars is left to the report on a source with no page shell', async () => {
  const findings = await staticEngine(
    fragment(
      'div{background:#ffffff}h1{font-size:4vw;color:#8a8a8a;font-weight:700}',
      '<div><h1>Grey heading on white</h1></div>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'low-contrast').map((f) => f.snippet),
    []
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
    ['font-size: 4vw']
  );
});

// The gate the report leaves is shared, and everything else behind it stays
// there: a rule about the type scale a page sets is a claim about a page, and a
// component source is not one. This is the same three sizes that read flat as a
// page, so a gate that let them through would be reporting a hierarchy read off
// a fragment of one.
test('the type-hierarchy rule is still refused a source with no page shell', async () => {
  const body = '<h1>a</h1><h2>b</h2><p>c</p>';
  const style = 'h1{font-size:18px}h2{font-size:17px}p{font-size:16px}';
  assert.deepEqual(
    (await staticEngine(page(style, body)))
      .filter((f) => f.antipattern === 'flat-type-hierarchy')
      .map((f) => f.snippet),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
  assert.deepEqual(
    (await staticEngine(fragment(style, body)))
      .filter((f) => f.antipattern === 'flat-type-hierarchy')
      .map((f) => f.snippet),
    []
  );
});

test('a heading whose size the engine cannot price is judged for the italic-serif display at the size it inherits', async () => {
  const findings = await staticEngine(
    page(
      'body{font-size:64px}h1{font-size:4vw;font-style:italic;font-family:Georgia,serif}',
      '<h1>An italic serif hero heading</h1>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'italic-serif-display').map((f) => f.snippet),
    ['italic serif h1 (georgia) at 64px "An italic serif hero heading"']
  );
});

test('a heading whose size the engine cannot price enters the repeated-kicker gate at the size it inherits', async () => {
  const findings = await staticEngine(
    page(
      'body{font-size:24px}h2{font-size:4vw}p.k{font-size:12px;letter-spacing:2px;text-transform:uppercase}',
      '<section><p class="k">PLATFORM</p><h2>Built for teams</h2></section>'
        + '<section><p class="k">PRICING</p><h2>Simple plans</h2></section>'
        + '<section><p class="k">SUPPORT</p><h2>Always available</h2></section>'
    )
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'repeated-section-kickers').map((f) => f.snippet),
    [
      'repeated section kicker "PLATFORM" before h2 "Built for teams" (3 on page)',
      'repeated section kicker "PRICING" before h2 "Simple plans" (3 on page)',
      'repeated section kicker "SUPPORT" before h2 "Always available" (3 on page)',
    ]
  );
});

// ---------------------------------------------------------------------------
// The regex engine
// ---------------------------------------------------------------------------

/** A finding every source below carries, so a silent rule is not a silent engine. */
const SOURCE_CONTROL = 'side-tab';
const CONTROL_CSS = '.sidebar { border-right: 3px solid #ef4444; }';

/** Run one source through the regex engine and return all of its findings. */
/**
 * @param {string} content
 * @param {string} name
 */
function regexEngine(content, name) {
  const findings = detectText(content, path.join(scratch, name), {});
  assert.ok(
    findings.some((f) => f.antipattern === SOURCE_CONTROL),
    'engine control: the regex engine must have run on this source'
  );
  return findings;
}

/**
 * @param {string} content
 * @param {string} name
 */
function regexUnresolvedSnippets(content, name) {
  return regexEngine(content, name)
    .filter((f) => f.antipattern === RULE)
    .map((f) => f.snippet);
}

/**
 * @param {string} content
 * @param {string} name
 */
function regexUnresolvedFindings(content, name) {
  return regexEngine(content, name)
    .filter((f) => f.antipattern === RULE)
    .map((f) => [f.line, f.snippet]);
}

// Every source type the regex engine reads, taken from the walker's own dispatch
// rather than written out: the walker scans `SCANNABLE_EXTENSIONS` and sends
// only `HTML_EXTENSIONS` to the static-HTML engine, so the difference between
// the two sets is exactly what reaches this engine. A type added to the walker
// therefore joins this population with no edit here, which is what makes the
// completeness claim true by construction. The engine is the only one that ever
// analyzes a source that is not HTML, so a type outside this population is a
// type nothing on the page says anything about.
/** @type {readonly string[]} */
const REGEX_ENGINE_EXTENSIONS = [...SCANNABLE_EXTENSIONS].filter(
  (ext) => !HTML_EXTENSIONS.has(ext)
);

// The floor under that derivation. Following the dispatch fixes the failure a
// hand-written population had — a type added to the walker joins this one with
// no edit here — but a derivation only guards against omission: move a type
// from the walker's scannable set into the static-HTML engine's and the
// population shrinks with it, silently, every case still passing. These are the
// types this engine is known to read, and they must stay members of it.
/** @type {readonly string[]} */
const REGEX_ENGINE_TYPE_FLOOR = [
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.jsx',
  '.tsx',
  '.js',
  '.ts',
  '.vue',
  '.svelte',
  '.astro',
];

test('every source type this engine is known to read is in the derived population', () => {
  assert.deepEqual(
    REGEX_ENGINE_TYPE_FLOOR.filter((ext) => !REGEX_ENGINE_EXTENSIONS.includes(ext)),
    [],
    'a type this engine reads has left the population the cases below are driven over'
  );
});

// The floor under the other derivation the engine runs on. The character class
// that declines a name is the union of a table keyed by source type, and a
// table can go short the way a hand-written population can: add a twelfth type
// to the walker and its grammar's sigils are in no entry, so a name that
// grammar opens reads as a declaration. Totality over the same published set is
// what reds instead — in both directions, so an entry outlasting the type it
// was written for is a red too rather than a line nothing reaches.
//
// It floors the ruled failure — a new source type in a new grammar. It does not
// floor a new sigil inside a grammar already here: nothing publishes a
// grammar's sigil set, and the exclusion's own docblock is the whole of that
// half's guard.
test('every source type this engine reads declares the sigils its grammars open a name with', () => {
  assert.deepEqual(
    REGEX_ENGINE_EXTENSIONS.filter((ext) => !(ext in NAME_SIGILS_BY_SOURCE_TYPE)),
    [],
    'a source type reaches this engine with no entry in the table its name class is derived from'
  );
});

test('every source type the sigil table declares is one this engine reads', () => {
  assert.deepEqual(
    Object.keys(NAME_SIGILS_BY_SOURCE_TYPE).filter((ext) => !REGEX_ENGINE_EXTENSIONS.includes(ext)),
    [],
    'the table declares sigils for a source type the walker no longer sends here'
  );
});

/** One unreducible declaration, in the shape a stylesheet writes it. */
const DECLARATION_CSS = `${CONTROL_CSS}\nh1 { font-size: 4vw; }\n`;

/** The extensions whose sources carry CSS inside a template literal. */
const CSS_IN_JS_EXTENSIONS = new Set(['.jsx', '.tsx', '.js', '.ts']);

/**
 * The shape a source of one type takes. A type this does not name falls back to
 * bare CSS, which every type reads, because the engine reads a file's text
 * whatever its extension — so a type new to the dispatch is still driven, and a
 * shape missing here costs realism rather than coverage.
 * @param {string} ext
 */
function sourceForExtension(ext) {
  if (ext === '.vue')
    return `<template><h1>a</h1></template>\n<style>\n${DECLARATION_CSS}</style>\n`;
  if (ext === '.svelte') return `<h1>a</h1>\n<style>\n${DECLARATION_CSS}</style>\n`;
  if (CSS_IN_JS_EXTENSIONS.has(ext)) return 'const S = styled.h1`\n' + DECLARATION_CSS + '`;\n';
  return DECLARATION_CSS;
}

// A population read from a dispatch can be read as empty, and an empty one makes
// every case below vacuous, so the derivation is asserted before it is used.
test('the source types driven here are the walker dispatch to the regex engine', () => {
  assert.ok(REGEX_ENGINE_EXTENSIONS.length > 0, 'the engine reads at least one source type');
  assert.deepEqual(
    REGEX_ENGINE_EXTENSIONS.filter((ext) => HTML_EXTENSIONS.has(ext)),
    [],
    'no type the static-HTML engine takes is driven through this engine'
  );
  assert.equal(
    REGEX_ENGINE_EXTENSIONS.length + HTML_EXTENSIONS.size,
    SCANNABLE_EXTENSIONS.size,
    'the two engines partition what the walker scans'
  );
});

for (const ext of REGEX_ENGINE_EXTENSIONS) {
  test(`the regex engine reports an unreducible font size in a ${ext} source`, () => {
    assert.deepEqual(regexUnresolvedSnippets(sourceForExtension(ext), `source${ext}`), [
      'font-size: 4vw',
    ]);
  });
}

test('the regex engine reports an unreducible font size in an HTML page', () => {
  const html = page('h1{font-size:4vw}p{font-size:16px}', `<h1>a</h1><p>c</p>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'fallback.html'), ['font-size: 4vw']);
});

// This source pinned the earlier law, under which a value the stand-in basis
// got a number out of was a value this engine had read. Its `em` and its
// percentage report now, so the case is split rather than dropped: the half
// that still holds keeps a case of its own, and the half the ruling moved gets
// one that pins where it moved to.
test('the regex engine reports nothing for a source whose every font size reduces at any basis', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: 2rem; }\nspan { font-size: 18px; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'reducible.css'), []);
});

test('the regex engine reports a font size it could price only from a stand-in basis', () => {
  const source = `${CONTROL_CSS}\nh2 { font-size: 1.0625em; }\np { font-size: 100%; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'relative.css'), [
    'font-size: 1.0625em',
    'font-size: 100%',
  ]);
});

// A `clamp()` reaches the reducer as its minimum endpoint, and the basis the
// endpoint consumed is carried back out of that recursion rather than lost at
// it — so a clamp() whose minimum is relative is a stand-in-priced size like
// any other.
test('the regex engine reports a clamp() whose minimum is relative to the stand-in basis', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: clamp(1.25em, 4vw, 3em); }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'clamp-em.css'), [
    'font-size: clamp(1.25em, 4vw, 3em)',
  ]);
});

// The two halves of the walk on one page, which is the law this ruling gave the
// engine: a size it cannot price stays out of the type scale AND is reported.
// The page carries a full-page shape and a page-carrying extension, because the
// scale half is gated on both and a source missing either would pin only the
// report. Before the ruling this page produced the scale line alone, and the
// `em` reached neither rule.
test('a font size the regex engine could price only from a stand-in basis is reported and left out of the type scale', () => {
  const html = page(
    `h1{font-size:2em}h2{font-size:17px}p{font-size:16px}span{font-size:18px}\n${CONTROL_CSS}`,
    '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
  );
  const found = regexEngine(html, 'stand-in-scale.html');
  assert.deepEqual(
    found.filter((f) => f.antipattern === RULE).map((f) => f.snippet),
    ['font-size: 2em']
  );
  assert.deepEqual(
    found.filter((f) => f.antipattern === 'flat-type-hierarchy').map((f) => f.snippet),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

// The shared reducer prices a clamp() at its minimum endpoint, so the regex
// engine takes it out of this population for the same reason the static engine
// does. Were the reduction not shared, every clamp() source would carry this.
test('the regex engine does not report a clamp() font size', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: clamp(20px, 4vw, 30px); }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'clamp.css'), []);
});

// A CSS declaration ends at its semicolon, not at a line ending, so where the
// value is written decides nothing about whether the engine reads it. The two
// faces pull opposite ways: a value on the next line must be reported, and a
// function broken over lines must be priced and stay silent.
test('the regex engine reports a font size whose value sits on the line after the colon', () => {
  const source = `${CONTROL_CSS}\nh1 {\n  font-size:\n    4vw;\n}\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'wrapped-value.css'), ['font-size: 4vw']);
});

test('the regex engine reports a font size whose colon sits on the line after the property', () => {
  const source = `${CONTROL_CSS}\nh1 {\n  font-size\n    : 4vw;\n}\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'wrapped-colon.css'), ['font-size: 4vw']);
});

test('the regex engine does not report a clamp() font size written across lines', () => {
  const source = `${CONTROL_CSS}\nh1 {\n  font-size: clamp(\n    1rem,\n    4vw,\n    2rem\n  );\n}\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'wrapped-clamp.css'), []);
});

// A snippet is the whole of what a finding says, and a value the source wrote
// over four lines is one value — so it is written as one.
test('the regex engine names a value broken across lines as one line', () => {
  const source = `${CONTROL_CSS}\nh1 {\n  font-size: calc(\n    4vw\n    + 2px\n  );\n}\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'wrapped-calc.css'), [
    'font-size: calc( 4vw + 2px )',
  ]);
});

// Reading a value across lines makes two shapes reachable that a line-bounded
// read never saw: a declaration with no value at all, and text that names the
// property without ever ending a declaration. Neither is a size, so neither is
// reported — the second is also what keeps the pass linear in file length.
test('the regex engine does not report a font-size declaration with no value', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`${CONTROL_CSS}\nh1 { font-size:; }\n`, 'empty.css'),
    []
  );
});

// A value the scan reaches its bound inside is a value the engine could not
// read, and reporting what it could not read is this rule. The shape that
// reaches the bound is the classic fluid-type interpolation written inline over
// design-token names; the static-HTML engine reports that same declaration on
// the same bytes, so dropping it here was a divergence between the engines.
// Where the bound cuts the value, the finding carries what was read up to it.
/** A fluid-type interpolation over design tokens, longer than the scan's bound. */
const FLUID_VALUE =
  'calc(var(--font-size-heading-min) * 1rem + (var(--font-size-heading-max) - var(--font-size-heading-min)) * ((100vw - var(--layout-viewport-width-min) * 1px) / (var(--layout-viewport-width-max) - var(--layout-viewport-width-min))))';

test('the regex engine reports a font size whose value runs past the bound it reads to', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: ${FLUID_VALUE}; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'fluid.css'), [
    'font-size: calc(var(--font-size-heading-min) * 1rem + (var(--font-size-heading-max) - var(--font-size-heading-min)) * ((100vw - var(--layout-viewport-width-min) * 1px) / (var(--layout-viewport-width-max) - var(',
  ]);
});

// The other shape the bound catches: text naming the property that never ends a
// declaration. It reports for the same reason — the engine read what it could
// and could not price it — and its snippet is equally bounded.
test('the regex engine reports a runaway value at the bound it stopped reading at', () => {
  const runaway = `${CONTROL_CSS}\nh1 { color: red; }\nfont-size: ${'a'.repeat(400)}\n`;
  assert.deepEqual(regexUnresolvedSnippets(runaway, 'runaway.css'), [
    `font-size: ${'a'.repeat(199)}`,
  ]);
});

// An interpolation with no closing brace inside the bound is the third way a
// value outruns the scan, and the same answer covers it: what was read, not
// silence. The brace is searched for only as far as the bound, so an
// interpolation closing past it and one never closing at all are one case.
test('the regex engine reports an interpolated value whose brace never closes', () => {
  const source = 'const S = styled.h1`\n' + CONTROL_CSS + '\n  font-size: ${p.size\n';
  assert.deepEqual(regexUnresolvedSnippets(source, 'unclosed.tsx'), ['font-size: ${p.size']);
});

// A value also ends at the quote that closes the attribute it was written in.
// An inline `style` is how a size reaches a source this engine reads without a
// stylesheet around it, and both quote spellings are used in the wild — a value
// read past its own closing quote swallows the rest of the tag.
test('the regex engine ends a value at the double quote closing an inline style', () => {
  const source = `${CONTROL_CSS}\n<div style="font-size: 4vw" class="hero">a</div>\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'attr-double.astro'), ['font-size: 4vw']);
});

test('the regex engine ends a value at the single quote closing an inline style', () => {
  const source = `${CONTROL_CSS}\n<div style='font-size: 4vw' class='hero'>a</div>\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'attr-single.astro'), ['font-size: 4vw']);
});

test('the regex engine reports each distinct declaration it could not reduce', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: 4vw; }\nh2 { font-size: 12pt; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'distinct.css'), [
    'font-size: 4vw',
    'font-size: 12pt',
  ]);
});

// A size behind a custom property is a declaration the engine saw and could not
// reduce, and the custom property's own definition is not a font-size
// declaration — reporting it would name the same size twice.
test('the regex engine reports a font size behind a custom property', () => {
  const source = `${CONTROL_CSS}\n:root { --display: 4vw; }\nh1 { font-size: var(--display); }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'custom-prop.css'), [
    'font-size: var(--display)',
  ]);
});

test('the regex engine does not report a custom property whose name ends in font-size', () => {
  const source = `${CONTROL_CSS}\n:root { --heading-font-size: 4vw; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'custom-prop-name.css'), []);
});

// A custom property is one of four ways a source type this engine reads
// introduces a name, and the declined name is the un-prefixed, un-suffixed one
// — the case the surrounding text in the definition cannot help with. Sass and
// its indented syntax write `$name`, Less writes `@name`, JavaScript starts an
// identifier with `$` or with any character outside ASCII, and each names a
// size that is reported at the declaration using it. Every sigil in the
// engine's own source types is driven, because the character class is derived
// from them and a derivation nothing drives is a claim.
test('the regex engine reads no font size from a Sass variable definition', () => {
  const source = `${CONTROL_CSS}\n$font-size: 4vw;\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'sass-variable.scss'), []);
});

test('the regex engine reads no font size from a Less variable definition', () => {
  const source = `${CONTROL_CSS}\n@font-size: 4vw;\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'less-variable.less'), []);
});

test('the regex engine reads no font size from an identifier opening with a dollar sign', () => {
  const source = `${CONTROL_CSS}\nconst t = { $fontSize: '4vw' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-dollar.tsx'), []);
});

test('the regex engine reads no font size from an identifier whose prefix is outside ASCII', () => {
  const source = `${CONTROL_CSS}\nconst t = { éfontSize: '4vw' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-non-ascii.tsx'), []);
});

test('the regex engine reads no font size from a private class field', () => {
  const source = `${CONTROL_CSS}\nclass A { #fontSize: '4vw' = '4vw'; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'private-field.ts'), []);
});

// ---------------------------------------------------------------------------
// What the reader took is a value, or the text was never a declaration
// ---------------------------------------------------------------------------

// The property's spelling stands in selector position too, and a pseudo-class
// puts a colon after it exactly where a declaration's colon goes, so
// `.font-size:hover` read as a declaration and reported `font-size: hover` — a
// value that is no size at all. The reader is where it closes: a selector binds
// no value, so the reason the name side declines a name does not reach one.
//
// The prefixes are the constructs a CSS-family grammar puts immediately before
// a type selector, the suffixes what a selector carries after one. Nothing
// publishes either set the way the walker publishes its extensions, so both are
// a floor rather than a derivation: a construct missing from them is a member
// these cases never drove.
//
// What the suffixes carry after the pseudo-class name is what decides the value
// rule, so each character a compound selector can chain under is one: a
// combinator written without spaces, a second pseudo-class, a pseudo-element, an
// attribute, a class. The last is the shape a namespaced member also has, and it
// is why that rule asks for a sigil rather than for the dot alone.
/** @type {readonly (readonly [string, string])[]} */
const SELECTOR_PREFIXES = [
  ['the start of a rule', ''],
  ['a descendant combinator', 'a '],
  ['a class selector', '.'],
  ['an id selector', '#'],
  ['a Sass placeholder', '%'],
  ['a namespace prefix', 'ns|'],
  ['a chained pseudo-class', 'a:hover:'],
  ['a pseudo-element', 'a::'],
  ['a child combinator', 'div>'],
  ['an adjacent sibling combinator', 'div+'],
  ['a general sibling combinator', 'div~'],
  ['a selector list comma', 'div,'],
  ['the universal selector', '*'],
  ['an attribute selector', '[data-x]'],
  ['a Sass parent reference', '&'],
];

/** @type {readonly string[]} */
const SELECTOR_SUFFIXES = [
  ':hover',
  '::before',
  ':first-child',
  ':-moz-focusring',
  ':hover, .icon',
  ':hover > .icon',
  ':hover>.icon',
  ':hover+.icon',
  ':hover~.icon',
  ':hover:focus',
  ':hover::before',
  ':hover[data-x]',
  ':hover.active',
];

for (const [opener, prefix] of SELECTOR_PREFIXES) {
  test(`the regex engine reads no font size from a selector following ${opener}`, () => {
    for (const suffix of SELECTOR_SUFFIXES) {
      const selector = `${prefix}font-size${suffix}`;
      assert.deepEqual(
        regexUnresolvedSnippets(`${CONTROL_CSS}\n${selector} { color: red; }\n`, 'selector.scss'),
        [],
        selector
      );
    }
  });
}

// The same defect in the other spelling. A quoted string is the shape of a
// value, so the off-stylesheet reader takes one wherever a field named
// `fontSize` holds it — and a CSS property name and an invalid preference value
// are both words this property does not take.
test('the regex engine reads no font size from a field holding a CSS property name', () => {
  const source = `${CONTROL_CSS}\nconst m = { fontSize: \`font-size\` };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'property-name.ts'), []);
});

test('the regex engine reads no font size from a field holding a word that names no size', () => {
  const source = `${CONTROL_CSS}\nconst p = { fontSize: 'huge' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'preference.ts'), []);
});

// The other half of the shape rule, and the half that is this rule's reason for
// existing: a value the engine cannot reduce is its subject matter, not an
// error. The keywords are written from the property's own grammar — its two
// size keyword families and the keywords every property takes — rather than
// read from the module, so a keyword the module forgets reds here.
/** @type {readonly string[]} */
const FONT_SIZE_KEYWORD_VALUES = [
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'larger',
  'smaller',
  'math',
  'inherit',
  'initial',
  'revert',
  'revert-layer',
  'unset',
];

test('the regex engine reports a font size written as one of the property keywords', () => {
  for (const keyword of FONT_SIZE_KEYWORD_VALUES) {
    assert.deepEqual(
      regexUnresolvedSnippets(`${CONTROL_CSS}\nh1 { font-size: ${keyword}; }\n`, 'keyword.css'),
      [`font-size: ${keyword}`],
      keyword
    );
  }
});

// A CSS keyword is ASCII case-insensitive exactly as the property's own
// spelling is, and the two are read by different code — the property by the
// pattern's flag, the keyword by the lookup here.
test('the regex engine reports a font size written as an upper-case keyword', () => {
  const source = `${CONTROL_CSS}\nh1 { FONT-SIZE: INHERIT; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'keyword-case.css'), ['font-size: INHERIT']);
});

test('the regex engine reports a min() font size', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: min(4vw, 2rem); }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'min.css'), ['font-size: min(4vw, 2rem)']);
});

// A vendor prefix is a shape the syntax puts in front of any identifier, not a
// member of the property's value set: `-webkit-xxx-large` is the same absolute
// size `xxx-large` is, and a size the engine cannot price either way. Adding
// the prefixed spelling to the keyword set would answer one prefix and one
// keyword, so the specimens vary vendor and keyword independently and only
// `-webkit-xxx-large` is one an implementation ships — the other two are the
// shape, and a rule keyed to one vendor or one keyword reds on them. None of the
// vendor-prefixed PSEUDO-classes strips to a keyword — `-moz-focusring` to
// `focusring`, `-webkit-any-link` to `any-link` — which is why the selector
// cells above are unmoved by it.
/** @type {readonly string[]} */
const VENDOR_PREFIXED_KEYWORDS = ['-webkit-xxx-large', '-webkit-x-large', '-moz-larger'];

test('the regex engine reports a font size written as a vendor-prefixed keyword', () => {
  for (const keyword of VENDOR_PREFIXED_KEYWORDS) {
    assert.deepEqual(
      regexUnresolvedSnippets(`${CONTROL_CSS}\nh1 { font-size: ${keyword}; }\n`, 'vendor.css'),
      [`font-size: ${keyword}`],
      keyword
    );
  }
});

test('the regex engine reports a vendor-prefixed keyword a style object holds', () => {
  const source = `${CONTROL_CSS}\nconst p = { fontSize: '-webkit-xxx-large' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'vendor-object.ts'), [
    'font-size: -webkit-xxx-large',
  ]);
});

// A namespace is reached through a dot, and what it exposes is a function or a
// variable. Both are values this engine cannot reduce, which is its subject
// matter — and a leading name that stops at the dot read them as the bare word
// the namespace is spelled with, so a size written this way went silent. The
// namespaces here are deliberately words the property does not name: `math.div`
// alone would pass while the rule read nothing but the keyword set.
/** @type {readonly string[]} */
const NAMESPACED_FUNCTION_VALUES = [
  'map.get($t, x)',
  'list.nth($l, 1)',
  'math.div(10px, 2)',
  't.size(1)',
  'Typography.size(1)',
  'a.b.c(1)',
];

test('the regex engine reports a font size a namespaced function writes', () => {
  for (const value of NAMESPACED_FUNCTION_VALUES) {
    assert.deepEqual(
      regexUnresolvedSnippets(`${CONTROL_CSS}\nh1 { font-size: ${value}; }\n`, 'namespace.scss'),
      [`font-size: ${value}`],
      value
    );
  }
});

// The variable half, and the half a call cannot answer: what tells `colors.$size`
// from the compound selector `hover.active` is the sigil its member opens with,
// which the module already derives from the grammars its source types are
// written in. The specimens are Sass module variables because Sass is the one
// grammar here that reaches a member under a sigil; the other sigils in that
// class are admitted by its own totality rather than by a case here.
/** @type {readonly string[]} */
const NAMESPACED_VARIABLE_VALUES = ['colors.$size', 'typography.$scale', 'scale.$step-3'];

test('the regex engine reports a font size a namespaced variable writes', () => {
  for (const value of NAMESPACED_VARIABLE_VALUES) {
    assert.deepEqual(
      regexUnresolvedSnippets(`${CONTROL_CSS}\nh1 { font-size: ${value}; }\n`, 'namespace.scss'),
      [`font-size: ${value}`],
      value
    );
  }
});

// The shape deliberately left outside: a qualified name carrying neither a call
// nor a sigil. No grammar this engine reads writes one as a value — Sass reaches
// a module member as `ns.$var` or `ns.fn(…)`, Less has no member syntax, and a
// JavaScript property access reaches a stylesheet only inside an interpolation,
// which opens with its own sigil. What does write it is a selector: a
// pseudo-class chained with a class is exactly this shape, so admitting it would
// reopen the cells above.
/** @type {readonly string[]} */
const UNQUALIFIED_MEMBER_VALUES = ['hover.active', 'theme.size'];

test('the regex engine reads no font size from a qualified name carrying no call or sigil', () => {
  for (const value of UNQUALIFIED_MEMBER_VALUES) {
    assert.deepEqual(
      regexUnresolvedSnippets(`${CONTROL_CSS}\nh1 { font-size: ${value}; }\n`, 'member.scss'),
      [],
      value
    );
  }
});

// A grammar's own interpolation and escape open a value with punctuation the
// reader stops at, so what it took is one character. That is a value it could
// not read rather than a word that is no value, and the two take opposite
// answers: the size is real and the engine cannot price it.
test('the regex engine reports a size a Sass interpolation writes', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: #{$size}; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'interpolation.scss'), ['font-size: #']);
});

test('the regex engine reports a size a Less escape writes', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: ~"4vw"; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'escape.less'), ['font-size: ~']);
});

// A word the scan's bound cut short is a word the engine never saw the end of,
// so the shape rule stands down and the rule's own answer for an unfinished
// read stands: report what was read. Its stylesheet twin is the runaway value
// above.
test('the regex engine reports a style object value it could not finish reading', () => {
  const source = `${CONTROL_CSS}\nconst p = { fontSize: '${'a'.repeat(400)}\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'unfinished.ts'), [
    `font-size: ${'a'.repeat(198)}`,
  ]);
});

// A size a template literal interpolates is a declaration this engine cannot
// reduce like any other, and the snippet is the whole of what a finding says —
// so the interpolation is read as one value rather than cut at its brace.
test('the regex engine names the whole interpolation in a size it could not reduce', () => {
  const source = 'const S = styled.h1`\n' + CONTROL_CSS + '\n  font-size: ${(p) => p.size};\n`;\n';
  assert.deepEqual(regexUnresolvedSnippets(source, 'interpolated.tsx'), [
    'font-size: ${(p) => p.size}',
  ]);
});

// A finding's line is what the CLI prints for the reader to navigate by, so it
// is asserted rather than left to the snippet. It counts from one, and it names
// where the declaration starts — not where its value was finally read.
test('the regex engine reports an unreducible font size at its declaration line', () => {
  const source = `${CONTROL_CSS}\n\nh1 { color: red; }\nh2 { font-size: 4vw; }\n`;
  assert.deepEqual(regexUnresolvedFindings(source, 'line.css'), [[4, 'font-size: 4vw']]);
});

test('the regex engine reports a declaration whose colon wrapped at the property line', () => {
  const source = `${CONTROL_CSS}\nh1 {\n  font-size\n    : 4vw;\n}\n`;
  assert.deepEqual(regexUnresolvedFindings(source, 'line-wrapped.css'), [[3, 'font-size: 4vw']]);
});

test('the report of an unreducible font size carries the regex engine stamp', () => {
  const reported = regexEngine(`${CONTROL_CSS}\nh1 { font-size: 4vw; }\n`, 'stamp.css').filter(
    (f) => f.antipattern === RULE
  );
  assert.ok(reported.length > 0, 'positive control: the rule must have fired on this source');
  assert.deepEqual([...new Set(reported.map((f) => f.engine))], [ENGINE_REGEX]);
});

// ---------------------------------------------------------------------------
// The spellings of a font size declaration
// ---------------------------------------------------------------------------

// A font size declaration is written three ways in the sources this engine is
// the only reader of, and what differs is how the property is spelled and
// delimited: a stylesheet's `font-size:`, the `font-size=` presentation
// attribute markup carries, and a style object's `fontSize:`. All three state
// the same property, so a size the engine cannot price is the same finding
// whichever wrote it — a spelling it cannot see is a page it says nothing about.
//
// The two off-stylesheet spellings read a value the way their own language
// writes one: what a quote holds, or a token beginning with a digit. Anything
// else in that position is a JavaScript expression rather than a value, and the
// engine has nothing to read in it — reporting one would name the source's own
// identifiers as a size.

test('the regex engine reports an unreducible font size in a style object', () => {
  const source = `${CONTROL_CSS}\nconst heading = { fontSize: '4vw' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'style-object.tsx'), ['font-size: 4vw']);
});

test('the regex engine reports an unreducible font size on a presentation attribute', () => {
  const source = `${CONTROL_CSS}\n<svg><text font-size="4vw">a</text></svg>\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'presentation.astro'), ['font-size: 4vw']);
});

// Both off-stylesheet spellings price a bare number and the stylesheet one
// does not: `{fontSize: 14}` renders at 14px and `font-size="14"` at 14 user
// units, while what `font-size: 14` in a rule renders is the document's answer
// rather than the property's — dropped in standards mode, 14px in quirks. So
// the same three characters reduce in two places and are reported in the
// third, where this engine has no document to ask.
test('a bare number in a style object is pixels, so the engine prices it', () => {
  const source = `${CONTROL_CSS}\nconst heading = { fontSize: 14 };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-number.tsx'), []);
});

test('a bare number on a presentation attribute is pixels, so the engine prices it', () => {
  const source = `${CONTROL_CSS}\n<svg><text font-size="14">a</text></svg>\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'attr-number.astro'), []);
});

test('a bare number in a stylesheet declaration is priced by no property, so it is reported', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: 14; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'sheet-number.css'), ['font-size: 14']);
});

test('the regex engine reads no font size from a style object value that is an expression', () => {
  const source = `${CONTROL_CSS}\nconst heading = { fontSize: props.size };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-expression.tsx'), []);
});

// A type annotation and a preference field are written in the same position as
// a style object's value and are not sizes, so the value rule is what keeps
// them out rather than a judgement about the surrounding code.
test('the regex engine reads no font size from a type annotation named fontSize', () => {
  const source = `${CONTROL_CSS}\ntype Prefs = { fontSize: string };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-type.ts'), []);
});

// A JavaScript property name is case-sensitive, so a differently-cased key is
// not this declaration; the CSS property and the HTML attribute are ASCII
// case-insensitive, so a differently-cased one is. Both halves are driven,
// because a single case rule over the whole pattern gets one of them wrong —
// measured on this repository's own built bundles, where an attribute-name map
// carries `fontsize:` and `fontSize:` a few characters apart.
test('the regex engine reads no font size from a differently-cased camelCase key', () => {
  const source = `${CONTROL_CSS}\nconst map = { fontsize: '4vw' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-case.ts'), []);
});

test('the regex engine reports an unreducible font size in an upper-case stylesheet declaration', () => {
  const source = `${CONTROL_CSS}\nh1 { FONT-SIZE: 4vw; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'sheet-case.css'), ['font-size: 4vw']);
});

// The lookbehind's two halves are driven apart, because each is sufficient on
// its own for the shape the other is usually shown with: a word character
// before the spelling is what declines `base_fontSize`, and the case rule above
// is what declines `headingFontSize`.
test('the regex engine reads no font size from an identifier whose suffix is fontSize', () => {
  const source = `${CONTROL_CSS}\nconst t = { base_fontSize: '4vw' };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-suffix.tsx'), []);
});

test('the regex engine names the whole interpolation in a style object size it could not reduce', () => {
  const source = `${CONTROL_CSS}\nconst heading = { fontSize: ` + '`${scale}vw`' + ` };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-template.tsx'), [
    'font-size: ${scale}vw',
  ]);
});

// The value ends where its own language ends it: a quote closes a quoted value
// and the next property never enters it, and an unquoted token ends at the
// comma after it.
test('the regex engine ends a style object value at the property after it', () => {
  const source = `${CONTROL_CSS}\nconst heading = { fontSize: '4vw', fontWeight: 700 };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-next.tsx'), ['font-size: 4vw']);
});

test('the regex engine ends an unquoted style object value at the comma after it', () => {
  const source = `${CONTROL_CSS}\nconst heading = { fontSize: 4vw, fontWeight: 700 };\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'object-unquoted.tsx'), ['font-size: 4vw']);
});

// The two engines write the same snippet for the same declaration, which is what
// makes a report from either comparable with the other.
test('both engines write the same snippet for the same unreducible declaration', async () => {
  const html = page('h1{font-size:4vw}p{font-size:16px}', `<h1>a</h1><p>c</p>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'compare.html'), await unresolvedSnippets(html));
});

// The same comparability over a declaration neither engine sees on one line.
// A page is written once and read by both, so a shape one engine reads and the
// other does not is a divergence the two readings expose directly.
test('both engines write the same snippet for a declaration broken across lines', async () => {
  const html = page(
    'h1 {\n  font-size:\n    4vw;\n}\np { font-size: 16px; }',
    `<h1>a</h1><p>c</p>${CONTROL_CSS}`
  );
  assert.deepEqual(regexUnresolvedSnippets(html, 'wrapped.html'), await unresolvedSnippets(html));
});

test('both engines stay silent on a clamp() broken across lines', async () => {
  const html = page(
    'h1 {\n  font-size: clamp(\n    1rem,\n    4vw,\n    2rem\n  );\n}\np { font-size: 16px; }',
    `<h1>a</h1><p>c</p>${CONTROL_CSS}`
  );
  assert.deepEqual(regexUnresolvedSnippets(html, 'wrapped-clamp.html'), []);
  assert.deepEqual(await unresolvedSnippets(html), []);
});

// ---------------------------------------------------------------------------
// The font-size presentation attribute, on both sides
// ---------------------------------------------------------------------------

// `font-size` is an SVG presentation attribute: SVG defines it as one of the
// attributes that states a style property, and HTML defines no content
// attribute of that name at all. So the cascade applies it on an SVG element
// and nowhere else — applying it on an HTML element would price that element at
// a size no rendering of the page shows, which is the fabricated size this
// engine reports rather than invents.

test('the static engine reports a font-size presentation attribute it cannot reduce', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('', '<svg><text font-size="4vw">a</text></svg>')),
    ['font-size: 4vw']
  );
});

test('the static engine does not report a font-size presentation attribute it can reduce', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('', '<svg><text font-size="1.5rem">a</text></svg>')),
    []
  );
});

// A presentation attribute prices a bare number and a stylesheet declaration
// does not, so the cascade reads the attribute's value the way the attribute
// writes one. Reporting `font-size="14"` would be this engine calling a size it
// can read unreadable, and the regex engine prices the same three characters.
test('a presentation attribute prices a bare number, so the cascade prices it too', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('', '<svg><text font-size="14">a</text></svg>')),
    []
  );
});

test('both engines price a bare number a presentation attribute states', async () => {
  const html = page('', `<svg><text font-size="14">a</text></svg>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'attr-bare.html'), []);
  assert.deepEqual(await unresolvedSnippets(html), []);
});

// The attribute states a size where nothing else does, so it loses to every
// author rule that states one — including the least specific rule there is.
test('a font size any rule states outranks the presentation attribute on the same element', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('*{font-size:19px}', '<svg><text font-size="4vw">a</text></svg>')
    ),
    []
  );
});

// The parse folds an upper-case spelling to the lower-case name the cascade
// reads; the regex engine's pattern is case-insensitive and reads it either
// way. Driven on both engines, because the spelling is exactly where the two
// could part.
test('both engines read a font-size presentation attribute written in upper case', async () => {
  const html = page('', `<svg><text FONT-SIZE="4vw">a</text></svg>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'attr-case.html'), ['font-size: 4vw']);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
});

// A utility class is a rule in a stylesheet this cascade never parsed, and a
// rule outranks a presentation attribute — so the class the size lookup reads
// wins over the attribute exactly as a parsed rule does. What the cascade
// records as specified on the element is what that lookup stands down for, and
// an attribute is not it.
test('a utility class outranks a presentation attribute on the same element', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('', '<svg><text class="text-3xl" font-size="4vw">a</text></svg>')
    ),
    []
  );
});

test('a presentation attribute a rule outranks leaves the rule its own report', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('text{font-size:4vw}', '<svg><text font-size="19px">a</text></svg>')
    ),
    ['font-size: 4vw']
  );
});

// The attribute is inherited like the property it states, so a descendant that
// states no size of its own is read at the one written above it. The ratio is
// what shows the inheritance: the element under test carries no font size, so a
// reading of 0.50 can only have come from the group's.
test('a font-size presentation attribute on an SVG group is the size the text under it is read at', async () => {
  const found = await staticEngine(
    page(
      '',
      `<svg><g font-size="30px"><text style="line-height:15px">${LONG_BODY}</text></g></svg>`
    )
  );
  assert.deepEqual(
    found.filter((f) => f.antipattern === 'tight-leading').map((f) => f.snippet),
    ['line-height 0.50x (need >=1.3)']
  );
});

test('the static engine reads no font size from a font-size attribute on an HTML element', async () => {
  assert.deepEqual(await unresolvedSnippets(page('', '<div font-size="4vw">a</div>')), []);
});

// A foreignObject holds HTML again, so the SVG subtree that admits the
// attribute ends at it.
test('the static engine reads no font size from a font-size attribute inside a foreignObject', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('', '<svg><foreignObject><div font-size="4vw">a</div></foreignObject></svg>')
    ),
    []
  );
});

// The report is not the only reader of a size: a rule that judges an element
// against its own size is given the one the attribute states.
test('a font-size presentation attribute is the size a rule reading that element is given', async () => {
  const found = await staticEngine(
    page('', `<svg><text font-size="30px" style="line-height:15px">${LONG_BODY}</text></svg>`)
  );
  assert.deepEqual(
    found.filter((f) => f.antipattern === 'tight-leading').map((f) => f.snippet),
    ['line-height 0.50x (need >=1.3)']
  );
});

// A relative value is stored by the cascade in the form the element reading it
// prices correctly, so the ratio a rule computes is the one the source states —
// including where the two disagree about which declaration states the size. A
// class outranks the attribute, so the class size is the one the cascade resolves
// against, and the attribute's size prices nothing.
test('a relative line-height beside a presentation attribute is the ratio the source states', async () => {
  const found = await staticEngine(
    page('', `<svg><text font-size="30px" style="line-height:1.2">${LONG_BODY}</text></svg>`)
  );
  assert.deepEqual(
    found.filter((f) => f.antipattern === 'tight-leading').map((f) => f.snippet),
    ['line-height 1.20x (need >=1.3)']
  );
});

test('a relative line-height under a class outranking a presentation attribute is loose at the class size', async () => {
  const found = await staticEngine(
    page(
      '',
      `<svg><text class="text-3xl" font-size="20" style="line-height:1.5">${LONG_BODY}</text></svg>`
    )
  );
  assert.deepEqual(
    found.filter((f) => f.antipattern === 'tight-leading').map((f) => f.snippet),
    []
  );
});

test('a relative line-height under a class outranking a presentation attribute is tight at the class size', async () => {
  const found = await staticEngine(
    page(
      '',
      `<svg><text class="text-3xl" font-size="40" style="line-height:1.2">${LONG_BODY}</text></svg>`
    )
  );
  assert.deepEqual(
    found.filter((f) => f.antipattern === 'tight-leading').map((f) => f.snippet),
    ['line-height 1.20x (need >=1.3)']
  );
});

// ---------------------------------------------------------------------------
// An attribute name written in any case
// ---------------------------------------------------------------------------

// An HTML attribute name is ASCII case-insensitive, so the same declaration is
// stated by `style`, `STYLE` and `Style` alike. The regex engine's patterns
// read all three; the parse folds all three to one name, so every reader of the
// document finds the declaration under that name, and a parse that left them as
// written would price the element at a size the page does not render.

test('both engines read a font size on a style attribute', async () => {
  const html = page('', `<h1 style="font-size:4vw">a</h1>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'attr-style-lower.html'), ['font-size: 4vw']);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
});

test('both engines read a font size on a style attribute written in upper case', async () => {
  const html = page('', `<h1 STYLE="font-size:4vw">a</h1>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'attr-style-upper.html'), ['font-size: 4vw']);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
});

test('both engines read a font size on a style attribute written in mixed case', async () => {
  const html = page('', `<h1 Style="font-size:4vw">a</h1>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'attr-style-mixed.html'), ['font-size: 4vw']);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
});

// The selector engine reads `class`, `id` and every `[attr]` by the lower-case
// name it folds a selector's to, so a rule reaches an element through a lookup
// this module never writes. Driven on the class attribute because nothing this
// module does at its own read sites reaches that lookup — only the parse is
// upstream of it.
test('both engines read a font size a rule states for a class attribute written in upper case', async () => {
  const html = page('.hero{font-size:4vw}', `<h1 CLASS="hero">a</h1>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'attr-class-upper.html'), ['font-size: 4vw']);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
});

// Two attributes differing only in case are one attribute, and a browser keeps
// the first. The parse folds both names alike and keeps the value it met first,
// which is that rule. The ordering that discriminates is the one where the
// differently-cased spelling is written first — a reader keeping the last
// answers a size no browser renders — so each case below drives that ordering
// against a different reader of the folded name.
test('the static engine reads the first of two style attributes when the lower-case spelling is written first', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('', '<h1 style="font-size:4vw" STYLE="font-size:16px">a</h1>')),
    ['font-size: 4vw']
  );
});

test('the static engine reads the first of two style attributes when the upper-case spelling is written first', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('', '<h1 STYLE="font-size:4vw" style="font-size:16px">a</h1>')),
    ['font-size: 4vw']
  );
});

test('the static engine reads the first of two class attributes when the upper-case spelling is written first', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('.hero{font-size:4vw}', '<h1 CLASS="hero" class="other">a</h1>')),
    ['font-size: 4vw']
  );
});

test('the static engine reads the first of two id attributes when the upper-case spelling is written first', async () => {
  assert.deepEqual(
    await unresolvedSnippets(page('#hero{font-size:4vw}', '<h1 ID="hero" id="other">a</h1>')),
    ['font-size: 4vw']
  );
});

test('the static engine reads the first of two font-size attributes when the upper-case spelling is written first', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('', '<svg><text FONT-SIZE="4vw" font-size="16px">a</text></svg>')
    ),
    ['font-size: 4vw']
  );
});

// The bytes a document is assembled from are chosen by an attribute too, so a
// name this engine misses costs it a whole stylesheet rather than one
// declaration. The regex engine reads the page's own bytes and never those.
test('a stylesheet linked through a rel attribute written in upper case reaches the document', async () => {
  fs.writeFileSync(
    path.join(scratch, 'linked-case.css'),
    `h1{font-size:4vw}\n${CONTROL_CSS}`,
    'utf-8'
  );
  const html = page('', `<link REL="stylesheet" HREF="./linked-case.css"><h1>a</h1>${CONTROL_CSS}`);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
  assert.deepEqual(regexUnresolvedSnippets(html, 'linked-case.html'), []);
});

// ---------------------------------------------------------------------------
// Where the two engines part, and why
// ---------------------------------------------------------------------------

// Where the two engines answer differently they answer differently for one of
// the reasons below, and every one of them is the same asymmetry: the
// static-HTML engine builds a document and the regex engine reads source text.
// What closes the list is a split rather than a count: the first four are what
// each engine makes of one declaration both of them were handed, and the fifth
// is every difference that is about no such declaration. A shape that fits none
// of them wants that split re-examined — the table below is reasons one and two
// only, so appending a row to it answers nothing.
//
//   1. The value is one only a document settles — a size relative to a parent's,
//      a custom property the page declares, the `inherit` keyword. The cascade
//      settles it; this engine prices it from a stand-in and reports that.
//   2. The declaration's element is one only a document identifies — an
//      attribute on an element whose language defines none, a rule that
//      outranks it, an object literal in a script that names no element at all.
//   3. The type scale's population is a set of elements, which only a document
//      has: the static engine prices the elements its text scan reads, and this
//      engine prices every declaration it finds.
//   4. The value is spelled back the way each engine read it — a parser's
//      round trip on one side, the source's own characters on the other.
//   5. The subject each engine reads is not the same subject. A document is
//      assembled from the file rather than being it: it holds what a
//      `<link rel="stylesheet">` pulls in, holds none of what a parse drops,
//      and holds what a parse made of what is left. And a document has no
//      source positions, so its sizes come back deduplicated across the whole
//      of it and sorted, with no line, where the text's come back in source
//      order, each carrying its line, deduplicated only inside a window of
//      lines. None of that is a reading of a declaration.
//
// Reason five is read wide: every difference that follows from a document
// being an assembly of the file belongs to it, whichever engine is the one
// reporting. The case that turns on the reading is a comment inside a property
// name, which is valid CSS: `font-size/**/:4vw` is a declaration to a CSS parse
// and no declaration at all to a scan of the characters, so the static engine
// reports it and the regex engine does not. One declaration was never handed to
// both, so the split puts it here rather than among the first four, and the
// case beneath the table drives it.
//
// The rows below are members of the first two, driven as a pair on one page so
// the difference is a measurement rather than a claim; the reasons are the
// population, and the rows are not. Reasons three, four and five have their own
// cases beneath the table, five in both directions — every row here is the
// regex engine reporting alone, and the fifth reason is the only one on which
// the static engine can be. The asymmetry is the design rather than a defect:
// this engine's finding names the declaration it saw, which is the strongest
// reading available to an engine that never builds a document.
/** @type {readonly { shape: string, style: string, body: string, regex: string[] }[]} */
const ENGINE_DIVERGENCES = [
  {
    shape: 'a font size relative to a size only a parent states',
    style: 'h1{font-size:1.5em}',
    body: '<h1>a</h1>',
    regex: ['font-size: 1.5em'],
  },
  {
    shape: 'a font size stated as a percentage of that size',
    style: 'h1{font-size:120%}',
    body: '<h1>a</h1>',
    regex: ['font-size: 120%'],
  },
  {
    shape: 'a font size behind a custom property the page declares',
    style: ':root{--display:18px}h1{font-size:var(--display)}',
    body: '<h1>a</h1>',
    regex: ['font-size: var(--display)'],
  },
  {
    shape: 'a font size taken from the parent by keyword',
    style: 'h1{font-size:inherit}',
    body: '<h1>a</h1>',
    regex: ['font-size: inherit'],
  },
  {
    shape: 'a font-size attribute on an element whose language defines none',
    style: '',
    body: '<div font-size="4vw">a</div>',
    regex: ['font-size: 4vw'],
  },
  {
    shape: 'a font size a script states for no element in particular',
    style: '',
    body: `<script>const s = { fontSize: '4vw' };</script>`,
    regex: ['font-size: 4vw'],
  },
];

for (const { shape, style, body, regex } of ENGINE_DIVERGENCES) {
  test(`the regex engine alone reports ${shape}`, async () => {
    const html = page(style, `${body}${CONTROL_CSS}`);
    assert.deepEqual(regexUnresolvedSnippets(html, 'divergence.html'), regex);
    assert.deepEqual(await unresolvedSnippets(html), []);
  });
}

// The one divergence that is not about which declarations are reported: both
// engines report this one, and they spell the value back differently. The
// static engine's snippet is what its CSS parser round-tripped, and the regex
// engine's is the text the source wrote — so the difference is in the
// serialization, and neither reading is available to the other engine.
test('the two engines spell a reported function value the way each of them read it', async () => {
  const html = page('h1{font-size:min(1rem, 2vw)}', `<h1>a</h1>${CONTROL_CSS}`);
  assert.deepEqual(regexUnresolvedSnippets(html, 'spelling.html'), ['font-size: min(1rem, 2vw)']);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: min(1rem,2vw)']);
});

// The third reason, driven: the same reducible size on the same element gives
// one engine a type scale and the other none, because the element is outside
// the static engine's text scan and inside every declaration this engine finds.
test('a size on an element outside the text scan reaches only the regex engine type scale', async () => {
  const html = page(
    'h2{font-size:16px}p{font-size:18px}',
    `<svg><text font-size="1.5rem">a</text></svg><h2>b</h2><p>c</p>${CONTROL_CSS}`
  );
  const scale = (/** @type {import('./findings.mjs').Finding[]} */ found) =>
    found.filter((f) => f.antipattern === 'flat-type-hierarchy').map((f) => f.snippet);
  assert.deepEqual(scale(regexEngine(html, 'population.html')), [
    'Sizes: 16px, 18px, 24px (ratio 1.5:1)',
  ]);
  assert.deepEqual(scale(await staticEngine(html)), []);
});

// Neither engine reads a Tailwind arbitrary value, and they are silent on it
// together — so the gap is a gap in what the detector reads, never a place the
// two answers part.
test('neither engine reads a font size out of a Tailwind arbitrary value', async () => {
  const html = page(
    '',
    `<h1 class="text-[16px]">a</h1><h2 class="text-[17px]">b</h2><p class="text-[4vw]">c</p>${CONTROL_CSS}`
  );
  assert.deepEqual(regexUnresolvedSnippets(html, 'arbitrary.html'), []);
  assert.deepEqual(await unresolvedSnippets(html), []);
});

// What a page analyzed by both engines emits, settled: nothing runs both over one
// file. The CLI sends a file to exactly one engine, and the static-HTML engine
// borrows only the four text-content analyzers from the regex engine, so this
// report reaches a page once and carries the stamp of the engine that read it.
test('a page the static-HTML engine reads carries one report of an unreducible size, not two', async () => {
  const findings = await staticEngine(
    page('h1{font-size:4vw}p{font-size:16px}', `<h1>a</h1><p>c</p>${CONTROL_CSS}`)
  );
  const reported = findings.filter((f) => f.antipattern === RULE);
  assert.equal(reported.length, 1);
  assert.deepEqual([...new Set(reported.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
});

// The fifth reason, driven in the direction no row above takes: a document is
// assembled from more than its own file, so a size only a linked stylesheet
// states reaches the engine that follows the link and no other. The third
// assertion is what makes this about which bytes were in play rather than about
// either engine's powers — handed that file, the regex engine reads the same
// size out of it.
test('a font size in a linked stylesheet reaches the engine handed those bytes', async () => {
  const linked = `h1{font-size:4vw}\n${CONTROL_CSS}`;
  fs.writeFileSync(path.join(scratch, 'linked.css'), linked, 'utf-8');
  const html = page('', `<link rel="stylesheet" href="./linked.css"><h1>a</h1>${CONTROL_CSS}`);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
  assert.deepEqual(regexUnresolvedSnippets(html, 'linked.html'), []);
  assert.deepEqual(regexUnresolvedSnippets(linked, 'linked.css'), ['font-size: 4vw']);
});

// The same reason the other way: a parse drops a comment, so the file carries
// bytes the document never holds and only the engine reading the file sees them.
test('a font size a comment holds reaches the regex engine alone', async () => {
  const html = page('/* h1{font-size:4vw} */', `<h1>a</h1>${CONTROL_CSS}`);
  assert.deepEqual(await unresolvedSnippets(html), []);
  assert.deepEqual(regexUnresolvedSnippets(html, 'commented.html'), ['font-size: 4vw']);
});

// And the reason where dropping a comment is what makes a declaration readable:
// a comment inside a property name is valid CSS, so the parse hands the
// document a declaration the characters never spelled. This is the case that
// fixes reason five's reading wide.
test('a font size behind a comment inside its property name reaches the static engine alone', async () => {
  const html = page('h1{font-size/**/:4vw}', `<h1>a</h1>${CONTROL_CSS}`);
  assert.deepEqual(await unresolvedSnippets(html), ['font-size: 4vw']);
  assert.deepEqual(regexUnresolvedSnippets(html, 'comment-property.html'), []);
});

// Where the engines part on multiplicity, pinned rather than left to chance. The
// static engine reads a document, so one declaration is one finding however many
// elements it reaches; the regex engine reads source lines, so a declaration
// written twice is two findings at two locations — the same convention every
// other matcher in that engine follows.
test('the regex engine reports a repeated declaration once per site', () => {
  const source = `${CONTROL_CSS}\nh1 { font-size: 4vw; }\n\n\n\n\nh2 { font-size: 4vw; }\n`;
  assert.deepEqual(regexUnresolvedSnippets(source, 'repeat.css'), [
    'font-size: 4vw',
    'font-size: 4vw',
  ]);
});

// ---------------------------------------------------------------------------
// What the regex engine reads AS a stylesheet
// ---------------------------------------------------------------------------

// A JavaScript source is not a stylesheet, and the characters `font-size:` in
// one are a declaration only where the language puts a declaration. Inside a
// quoted string or a regular-expression literal they are neither: the test file
// that guards a stylesheet asserts against its text with patterns like
// `/html\s*{\s*font-size:\s*106\.25%/`, and each such pattern was read as a
// declaration whose value was the rest of the pattern. A template literal is
// the exception and stays read, because it is where a source writes CSS.

test('a font size inside a regular-expression literal is not a declaration', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\nexpect(css).toMatch(/html\\s*{\\s*font-size:\\s*106\\.25%/);\n`,
      'guard.ts'
    ),
    []
  );
});

test('a font size inside a quoted string is not a declaration', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`${CONTROL_CSS}\nconst rule = 'font-size: 4vw';\n`, 'guard.ts'),
    []
  );
});

test('a font size inside a template literal is still a declaration', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\nconst css = \`h1 { font-size: 4vw }\`;\n`,
      'styles.ts'
    ),
    ['font-size: 4vw']
  );
});

// The read walks into a template rather than over it, so the template's own
// text is not code: an apostrophe standing in a sentence there opens no string,
// and a declaration after it is still read.
test('an apostrophe inside a template literal opens no string', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\nconst css = \`<p>it's here</p><style>h1{font-size:4vw}</style>\`;\n`,
      'styles.ts'
    ),
    ['font-size: 4vw']
  );
});

// A markup tag opens with the character a regular-expression literal cannot
// open after, and a component source is full of them: `</span>` puts a `/`
// straight after a `<`. Admitting that position would read the rest of the line
// as a pattern and silence every declaration standing in it.
test('a closing markup tag opens no regular-expression literal', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\nconst el = <div><span>a</span><b style={{ fontSize: '4vw' }}>c</b></div>;\n`,
      'view.tsx'
    ),
    ['font-size: 4vw']
  );
});

test('a style object holding a quoted size is still a declaration', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`${CONTROL_CSS}\nconst s = { fontSize: '4vw' };\n`, 'styles.ts'),
    ['font-size: 4vw']
  );
});

test('a stylesheet is read as a stylesheet whatever quotes it holds', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\n.a::after { content: "x"; }\nh1 { font-size: 4vw }\n`,
      'sheet.css'
    ),
    ['font-size: 4vw']
  );
});

// ---------------------------------------------------------------------------
// The root element's own basis
// ---------------------------------------------------------------------------

// A font size relative to the parent's has no parent on the root element, so it
// resolves against the initial value a browser starts from — 16px — and the
// engine can price it exactly rather than from a stand-in. Every other selector
// keeps the stand-in and stays unpriced.

test('a percentage on the root element is priced against the initial font size', () => {
  assert.deepEqual(regexUnresolvedSnippets(`${CONTROL_CSS}\nhtml { font-size: 106.25% }\n`, 'root.css'), []);
});

test('a percentage on the root pseudo-class is priced against the initial font size', () => {
  assert.deepEqual(regexUnresolvedSnippets(`${CONTROL_CSS}\n:root { font-size: 150% }\n`, 'root.css'), []);
});

test('a percentage on a qualified root selector is priced against the initial font size', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`${CONTROL_CSS}\nhtml.a11y-font-scale-88 { font-size: 93.75% }\n`, 'root.css'),
    []
  );
});

test('a percentage on the root inside a media query is priced against the initial font size', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\n@media (width < 48rem) {\n  html { font-size: 100% }\n}\n`,
      'root.css'
    ),
    []
  );
});

test('an em on the root element is priced against the initial font size', () => {
  assert.deepEqual(regexUnresolvedSnippets(`${CONTROL_CSS}\nhtml { font-size: 1.5em }\n`, 'root.css'), []);
});

// A comment stands between two rules as often as nothing does, and it is not
// part of the selector that follows it.
test('a comment before the root selector does not hide it', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `${CONTROL_CSS}\n.card { color: red }\n/* the root baseline */\nhtml { font-size: 106.25% }\n`,
      'root.css'
    ),
    []
  );
});

test('a percentage on a descendant of the root is not priced', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`${CONTROL_CSS}\nhtml.a11y-font-scale-88 input { font-size: 87.5% }\n`, 'root.css'),
    ['font-size: 87.5%']
  );
});

test('a percentage on a selector that is not the root is not priced', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`${CONTROL_CSS}\n.card { font-size: 87.5% }\n`, 'root.css'),
    ['font-size: 87.5%']
  );
});

test('a viewport unit on the root element is still not priced', () => {
  assert.deepEqual(regexUnresolvedSnippets(`${CONTROL_CSS}\nhtml { font-size: 4vw }\n`, 'root.css'), [
    'font-size: 4vw',
  ]);
});

test('the size a root percentage prices to is the one the type scale reads', () => {
  // The type scale is a page-level reading, so it is driven on a page. 150% of
  // the 16px a browser starts from is 24px, and the scale it joins is the one
  // the other two declarations state.
  const findings = regexEngine(
    page(`${CONTROL_CSS}html{font-size:150%}h1{font-size:25px}p{font-size:20px}`, '<h1>a</h1><p>c</p>'),
    'scale.html'
  );
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'flat-type-hierarchy').map((f) => f.snippet),
    ['Sizes: 20px, 24px, 25px (ratio 1.3:1)']
  );
});

// The static-HTML engine reads the same page through a cascade, where the root
// element's basis is the initial value already — so this is a pin on an answer
// the two engines have to give alike, not a change to one of them.
test('the static engine prices a root percentage against the initial font size too', async () => {
  assert.deepEqual(
    await unresolvedSnippets(
      page('html{font-size:150%}h1{font-size:25px}p{font-size:20px}', '<h1>a</h1><p>c</p>')
    ),
    []
  );
});

// A stylesheet is not always a whole file. Where one is written inside a
// `<style>` element or a template literal, the text before it is markup or
// JavaScript, and a selector read that ran past the container's opening
// delimiter swallowed that text and read the whole prefix as the selector — so
// the FIRST rule in an embedded stylesheet was the one shape where the root
// element went unrecognised. The container's opener is a selector boundary for
// the same reason the previous rule's `}` is: nothing before it can be part of
// this selector. Each case here puts real text before the container and the
// engine control after the rule, so the rule under test is genuinely first.

test('the first rule in a style element states the root element', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `<div class="hero">Text</div>\n<style>\nhtml { font-size: 150% }\n${CONTROL_CSS}\n</style>\n`,
      'p.astro'
    ),
    []
  );
});

test('the first rule in a template literal states the root element', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `export const css = \`html { font-size: 150% }\n${CONTROL_CSS}\``,
      'v.tsx'
    ),
    []
  );
});

test('the first rule in a stylesheet states the root element', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(`html { font-size: 150% }\n${CONTROL_CSS}\n`, 'r.css'),
    []
  );
});

test('the first rule in a style element that is not the root is still not priced', () => {
  assert.deepEqual(
    regexUnresolvedSnippets(
      `<div class="hero">Text</div>\n<style>\n.card { font-size: 87.5% }\n${CONTROL_CSS}\n</style>\n`,
      'p.astro'
    ),
    ['font-size: 87.5%']
  );
});
