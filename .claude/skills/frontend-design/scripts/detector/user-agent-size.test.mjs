/**
 * The size an element takes from the browser's own default stylesheet, as every
 * static-HTML rule that reads a size sees it. Six headings and `small`.
 *
 * The cascade is built from the page's own stylesheets, and no page carries the
 * sheet the browser applies before them — so a heading that states no size of
 * its own used to be priced at whatever it inherited, where a browser renders it
 * at a multiple of that. A bare `<h1>` in a 96px container was priced 96px and
 * rendered 192px, which is the ordinary shape of a heading inside a sized
 * section rather than anything exotic.
 *
 * WHERE THE EXPECTED SIZES COME FROM. Every size asserted here was read off a
 * real render of the same shape in Chromium, Firefox and WebKit, all three
 * agreeing — the computed `font-size` off a browser's own layout, never a
 * number this engine produced. Re-taking one means rendering the shape again
 * and reading that computed value. None of them is taken from a specification
 * or from memory: the sheet is the browser's,
 * so only the browser can say what is in it. The ratios are 2, 1.5, 1.17, 1,
 * 0.83 and 0.67 for `h1` through `h6`, each against the size the element above
 * states, and the same at every basis driven — a 5px, 6px, 8px, 16px and 40px
 * parent all give the same ratio in all three engines. `small` is the size above
 * it divided by 1.2, driven at seventeen parent sizes.
 *
 * The bases here are chosen to put the heading under the 12px floor
 * `tiny-text` reports at, because that rule prints the size it priced and is
 * therefore the one that can state a wrong answer instead of merely going
 * silent. The two rules whose thresholds sit at the other end of the scale
 * carry the large cases.
 *
 * Scope is `font-size` and nothing else. The default sheet also states margins,
 * weights and display types for these elements; no rule here reads any of them.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Nothing else
 * reaches them — `.claude/**` is outside every workspace glob, so no vitest
 * project, no ESLint config and no typecheck sees them. Run them on their own
 * with `node --test` and an explicit file list; a bare directory argument is an
 * invocation error, not a red suite.
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

const LONG_HEADING = 'A headline long enough to clear the forty character floor';
const BODY_COPY = 'Body copy that is comfortably longer than twenty characters.';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-ua-size-'));
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

// --- the carded shape, at both sources a container size can come from --------
//
// The two rows differ only in where the container's 96px is written, and the
// engine was wrong on both: the class-stated one is what the size-model work
// found, and the declared one shows the gap was never about classes.

test('a bare h1 under a class-sized ancestor is priced at twice that size', async () => {
  const found = await staticFindings(
    page('', `<div class="text-8xl"><h1>${LONG_HEADING}</h1></div>`),
    'oversized-h1'
  );
  assert.deepEqual(found, [`192px h1, 57 chars "${LONG_HEADING}"`]);
});

test('a bare h1 under a declared-size ancestor is priced at twice that size', async () => {
  const found = await staticFindings(
    page('div{font-size:96px}', `<div><h1>${LONG_HEADING}</h1></div>`),
    'oversized-h1'
  );
  assert.deepEqual(found, [`192px h1, 57 chars "${LONG_HEADING}"`]);
});

// --- one case per heading level, pinning the ratio the render gives ----------

test('a bare h1 is priced at twice the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:5px}', `<div><h1>${BODY_COPY}</h1></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

test('a bare h2 is priced at one and a half times the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:5px}', `<div><h2>${BODY_COPY}</h2></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['7.5px body text']);
});

test('a bare h3 is priced at 1.17 times the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:8px}', `<div><h3>${BODY_COPY}</h3></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['9.36px body text']);
});

test('a bare h4 is priced at the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:8px}', `<div><h4>${BODY_COPY}</h4></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['8px body text']);
});

test('a bare h5 is priced at 0.83 times the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:8px}', `<div><h5>${BODY_COPY}</h5></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['6.64px body text']);
});

test('a bare h6 is priced at 0.67 times the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:8px}', `<div><h6>${BODY_COPY}</h6></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['5.36px body text']);
});

// --- the size reaches the elements below the heading ------------------------

test('an element inside a bare heading inherits the size the default sheet gave it', async () => {
  const found = await staticFindings(
    page('div{font-size:5px}', `<div><h1><span>${BODY_COPY}</span></h1></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

test('an em inside a bare heading resolves against the size the default sheet gave it', async () => {
  const found = await staticFindings(
    page('div{font-size:8px}', `<div><h1><span style="font-size:0.5em">${BODY_COPY}</span></h1></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['8px body text']);
});

// --- sectioning depth does not change the size ------------------------------
//
// The HTML rendering spec once sized an `h1` by how deep it sat inside
// sectioning content, which would make this 5.85px rather than 10px. Driven in
// all three engines at every depth to three levels, none of them still does.

test('sectioning depth does not change the size the default sheet gives a heading', async () => {
  const found = await staticFindings(
    page('div{font-size:5px}', `<div><section><section><h1>${BODY_COPY}</h1></section></section></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

// --- what outranks the default sheet ----------------------------------------
//
// Every guard below is green before this reading was added as well as after:
// each one is a size the engine already priced correctly, and an implementation
// that let the default sheet reach these elements would move it.

test('a size a rule states for a heading outranks the default sheet', async () => {
  const found = await staticFindings(
    page('div{font-size:5px}h1{font-size:9px}', `<div><h1>${BODY_COPY}</h1></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['9px body text']);
});

// The heading itself cannot show this. Every reader of a class-sized element asks the
// class again on its way to a size, so a sheet value written over the class is read back
// past. The element BELOW it is where the two differ: a descendant that states nothing
// inherits whatever the heading was left holding, and asks no class of its own.
test('a size a utility class states for a heading reaches the elements below it', async () => {
  const html = page(
    'div{font-size:5px}',
    `<div><h1 class="text-8xl">${LONG_HEADING}<span>${BODY_COPY}</span></h1></div>`
  );
  // The heading's text is its own plus the span's, so the character count and the
  // quoted excerpt are built from both. `96px` is the part under test.
  const headingText = LONG_HEADING + BODY_COPY;
  assert.deepEqual(await staticFindings(html, 'oversized-h1'), [
    `96px h1, ${headingText.length} chars "${headingText.slice(0, 60)}"`,
  ]);
  // The span is at the class's 96px. Were the sheet writing over the class it would be
  // at twice the 5px above the heading, which is under the floor `tiny-text` reports at.
  assert.deepEqual(await staticFindings(html, 'tiny-text'), []);
});

test('an explicit inherit on a heading outranks the default sheet', async () => {
  const found = await staticFindings(
    page('', `<div class="text-8xl"><h1 style="font-size:inherit">${LONG_HEADING}</h1></div>`),
    'oversized-h1'
  );
  assert.deepEqual(found, [`96px h1, 57 chars "${LONG_HEADING}"`]);
});

test('a heading under a size the reducer cannot price is reported rather than priced', async () => {
  const html = page('div{font-size:4vw}', `<div><h6>${BODY_COPY}</h6></div>`);
  // The engine says it could not read the size...
  assert.deepEqual(await staticFindings(html, 'unresolvable-font-size'), ['font-size: 4vw']);
  // ...and hands no rule a size built on the stand-in basis it falls back to. The sheet
  // against that basis would put this heading at 10.72px, under the `tiny-text` floor.
  assert.deepEqual(await staticFindings(html, 'tiny-text'), []);
});

test('an element the default sheet states no size for is priced at the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:8px}', `<div><p>${BODY_COPY}</p></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['8px body text']);
});

// --- the element the sheet sizes with a keyword rather than an em ------------
//
// `small` is the one non-heading element this cascade models, and it is here
// because a rule genuinely reads its size: `tiny-text` walks every element and
// its skip list names `sub`, `sup`, `code`, `kbd`, `samp`, `var`, `caption` and
// `figcaption` — not this tag. So a bare `<small>` in a 13px container renders
// at 10.83px and was priced 13px, which is the same rule stating a wrong answer
// rather than going silent.
//
// WHERE THE RATIO COMES FROM, AND WHY IT IS WRITTEN TO SIXTEEN PLACES. The sheet
// says `font-size: smaller` here, which is not an `em` and not a number — it is
// a division of the parent's size by 1.2. Driven in Chromium, Firefox and WebKit
// at seventeen parent sizes plus a nested pair and two keyword-sized parents:
// every row is the parent over 1.2, the factor never steps or saturates, and it
// compounds per element. The decimal in the cascade's map is the double nearest
// that quotient, and it was checked to reproduce the division bit for bit at
// 200,000 bases from 0.01px to 2000px — a four-place decimal reproduces it at
// none of them, and at a 14.4px parent lands 11.9995px under a floor the browser
// renders exactly on.

test('a bare small is priced at five sixths of the size above it', async () => {
  const found = await staticFindings(
    page('div{font-size:12px}', `<div><small>${BODY_COPY}</small></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

// One application of the factor leaves this page at 12px and silent, so the case
// is asking whether the sheet is applied per element rather than once.
test('a small inside a small takes the ratio twice', async () => {
  const found = await staticFindings(
    page('div{font-size:14.4px}', `<div><small><small>${BODY_COPY}</small></small></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

test('an element inside a bare small inherits the size the default sheet gave it', async () => {
  const found = await staticFindings(
    page('div{font-size:12px}', `<div><small><span>${BODY_COPY}</span></small></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

// The tracking rule reads the size as its own denominator, so a page can leave
// the size unreported and still be answered wrongly. 0.6px of tracking is
// 0.046em of a 13px size and 0.055em of the 10.83px this element renders at, and
// the floor between them is 0.05em.
test('a size the default sheet gives a small is the basis the tracking rule divides by', async () => {
  const found = await staticFindings(
    page('div{font-size:13px}', `<div><small style="letter-spacing:0.6px">${BODY_COPY}</small></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

test('a size a rule states for a small outranks the default sheet', async () => {
  const found = await staticFindings(
    page('div{font-size:20px}small{font-size:9px}', `<div><small>${BODY_COPY}</small></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['9px body text']);
});

// The `small` itself cannot show this, for the reason the heading guard above
// records: every reader of a class-sized element asks the class again on its way
// to a size. The element below it is where a sheet value written over the class
// would surface, because it inherits what the `small` was left holding.
test('a size a utility class states for a small reaches the elements below it', async () => {
  const found = await staticFindings(
    page('div{font-size:6px}', `<div><small class="text-xs"><span>${BODY_COPY}</span></small></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

// A single `small` against the 16px stand-in is 13.33px and crosses no
// threshold, so the pair is what makes dropping this guard visible: two of them
// against that stand-in is 11.11px, under the floor.
test('a small under a size the reducer cannot price is reported rather than priced', async () => {
  const html = page('div{font-size:4vw}', `<div><small><small>${BODY_COPY}</small></small></div>`);
  assert.deepEqual(await staticFindings(html, 'unresolvable-font-size'), ['font-size: 4vw']);
  assert.deepEqual(await staticFindings(html, 'tiny-text'), []);
});

// --- the two elements the sheet sizes with the same keyword ------------------
//
// `sub` and `sup` take `font-size: smaller` exactly as `small` does, and they
// were left unmodelled once on the reading that no rule reads them. That reading
// was made over one rule and is wrong over the rule set. The rule that reports a
// small size does skip both tags by name — and that skip covers the element
// only, so the same rule reads the size again through anything nested inside it.
//
// TWELVE VERDICTS MOVE ON THESE TAGS, and the count is a measurement rather than
// a reading: the tracking, negative-tracking, leading, contrast, purple-text,
// hierarchy, eyebrow and small-size verdicts, plus the over-large-heading,
// italic-serif-heading, flush-inset and section-kicker verdicts. Every one was
// answered against a size the browser never puts on the page.
//
// The last four are here because three successive readings missed them and a
// twenty-shape search did not contain a page that would have shown any of them.
// They share a mechanism: each is reached through a DESCENDANT of the element
// rather than through the element itself, which no reading of a rule's own tag
// gates can find. The search that closes it is derived rather than counted:
// `size-exposure/derivation.mjs` computes from the engine's own source the set
// of registered ids a modelled size can reach, and `size-exposure/sweep.mjs`
// fails when the population does not cover that set.
//
// One case per verdict that moves, so a rule dropping out of that set shows up
// here as a case that stops being about anything rather than as a silent
// narrowing. The count in the sentence above is what the case list below has to
// match; a verdict named there and absent here is the defect this comment
// previously carried, when it claimed one case per mover beside a list that was
// missing five.
//
// WHERE THE RATIO COMES FROM. Driven for these two tags in their own right,
// never carried across from `small`: seventeen parent sizes in Chromium, Firefox
// and WebKit, plus a `sub` in a `sub`, a `sup` in a `sup`, a `sub` in a `sup`,
// two keyword-sized parents, and fifteen precedence shapes. Every row is the
// size above divided by 1.2; the factor compounds per element; an inline size, a
// stylesheet rule and an explicit `inherit` each replace it outright, `revert`
// returns it, and an author `em` on the element resolves against the size above
// rather than against the sheet's.
//
// `vertical-align` is out of scope here as it has been throughout. The sheet
// states it for both tags, no rule in this detector reads it, and this cascade
// models `font-size` only.

test('a size the default sheet gives a sub is the basis the tracking rule divides by', async () => {
  const found = await staticFindings(
    page('div{font-size:13px}', `<div><sub style="letter-spacing:0.6px">${BODY_COPY}</sub></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

test('a size the default sheet gives a sup is the basis the tracking rule divides by', async () => {
  const found = await staticFindings(
    page('div{font-size:13px}', `<div><sup style="letter-spacing:0.6px">${BODY_COPY}</sup></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

// One application of the factor leaves this page at 13.33px, where 0.6px of
// tracking is 0.045em and under the floor, so the case is asking whether the
// sheet is applied per element rather than once.
test('a sub inside a sub takes the ratio twice', async () => {
  const found = await staticFindings(
    page('', `<sub><sub style="letter-spacing:0.6px">${BODY_COPY}</sub></sub>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.05em on body text']);
});

test('an element inside a bare sup inherits the size the default sheet gave it', async () => {
  const found = await staticFindings(
    page('div{font-size:13px}', `<div><sup><span style="letter-spacing:0.6px">${BODY_COPY}</span></sup></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

// The contrast rule picks its minimum by size: 18pt, which is 24px, is the bar
// between the 3:1 and 4.5:1 minimums. A 26px container puts a bare `sub` at
// 21.67px, on the other side of it, so the same colours that clear the lenient
// bar fail the strict one.
test('the size the default sheet gives a sub decides which contrast minimum applies to it', async () => {
  const found = await staticFindings(
    page('body{background-color:#ffffff}div{font-size:26px}',
      `<div><sub style="color:#949494">${BODY_COPY}</sub></div>`),
    'low-contrast'
  );
  assert.deepEqual(found, ['3.0:1 (need 4.5:1) — text #949494 on #ffffff']);
});

// The one verdict here that STOPS being reported. A 15px leading is 1.15x of a
// 13px size and 1.38x of the 10.83px this element renders at, so the size the
// sheet gives it is what takes the page off the wrong side of the 1.3 floor.
test('the size the default sheet gives a sub is the basis the leading rule divides by', async () => {
  const found = await staticFindings(
    page('div{font-size:13px}', `<div><sub style="line-height:15px">${BODY_COPY}</sub></div>`),
    'tight-leading'
  );
  assert.deepEqual(found, []);
});

// The purple-text rule treats anything at 20px or more as heading-scale. A 23px
// container leaves a bare `sup` at 19.17px, under that gate.
test('the size the default sheet gives a sup decides whether the purple-text rule reads it as heading-scale', async () => {
  const found = await staticFindings(
    page('body{background-color:#ffffff}div{font-size:23px}',
      `<div><sup style="color:#9333ea">${BODY_COPY}</sup></div>`),
    'ai-color-palette'
  );
  assert.deepEqual(found, []);
});

// The page-level type scan counts the elements it visits, and a `sub` is not one
// of them — but everything under it is, so the size the sheet gives it reaches
// the scan through the element below. The wrapper is a `section` because a `div`
// is in that scan's population and would hold the largest size fixed whatever
// its child renders at.
test('the size the default sheet gives a sub reaches the page type scan through the element below it', async () => {
  const found = await staticFindings(
    page('p{font-size:16px}li{font-size:17px}',
      `<p>${BODY_COPY}</p><ul><li>${BODY_COPY}</li></ul>` +
      `<section style="font-size:34px"><sub><span>${BODY_COPY}</span></sub></section>`),
    'flat-type-hierarchy'
  );
  assert.deepEqual(found, ['Sizes: 16px, 17px, 28.3px (ratio 1.8:1)']);
});

// The eyebrow rule takes the element above an `h1` whatever tag it carries, and
// admits it only under 14px. At the document default a bare `sub` renders
// 13.33px, under that ceiling, where the 16px it used to be priced at is over.
test('the size the default sheet gives a sub decides whether the eyebrow rule admits it', async () => {
  const found = await staticFindings(
    page('', '<div><sub style="text-transform:uppercase;letter-spacing:2px">LAUNCH WEEK</sub>' +
      `<h1>${LONG_HEADING}</h1></div>`),
    'hero-eyebrow-chip'
  );
  assert.deepEqual(found, [`eyebrow chip (tracked-caps) "LAUNCH WEEK" above h1 "${LONG_HEADING}"`]);
});

// The rule that reports a small size is the one rule that does NOT move here,
// and it is pinned rather than left implicit: both sizes on this page are under
// its floor, so what it says is decided by its skip list, which names both tags.
test('the rule that reports a small size still declines a sub by name', async () => {
  const found = await staticFindings(
    page('div{font-size:11px}', `<div><sub>${BODY_COPY}</sub></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('a size a rule states for a sup outranks the default sheet', async () => {
  const found = await staticFindings(
    page('div{font-size:13px}sup{font-size:20px}',
      `<div><sup style="letter-spacing:0.6px">${BODY_COPY}</sup></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

// The `sub` itself cannot show this, for the reason the heading and `small`
// guards above record: every reader of a class-sized element asks the class
// again on its way to a size. The element below it is where a sheet value
// written over the class would surface.
test('a size a utility class states for a sub reaches the elements below it', async () => {
  const found = await staticFindings(
    page('div{font-size:6px}', `<div><sub class="text-xs"><span style="letter-spacing:0.6px">${BODY_COPY}</span></sub></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

// A single `sub` against the 16px stand-in is 13.33px, where 0.6px of tracking
// is under the floor, so the pair is what makes dropping this guard visible:
// two of them against that stand-in is 11.11px, where it is over.
test('a sub under a size the reducer cannot price is reported rather than priced', async () => {
  const html = page('div{font-size:4vw}',
    `<div><sub><sub style="letter-spacing:0.6px">${BODY_COPY}</sub></sub></div>`);
  assert.deepEqual(await staticFindings(html, 'unresolvable-font-size'), ['font-size: 4vw']);
  assert.deepEqual(await staticFindings(html, 'wide-tracking'), []);
});

// --- the four verdicts reached through a descendant --------------------------
//
// Each of these was ruled a non-reader once. The first two on the true and
// irrelevant ground that the heading rules read a heading's own size — true, and
// no bar, because the heading can be the descendant. The third on the ground
// that the inset rule needs a layout rectangle, which is so of one of its two
// arms. The fourth on the ground that the kicker rule's tag allowlist excludes
// these tags, which stops one standing AS a kicker and not one wrapping a kicker
// and its heading together.

// A 50px section puts a bare `sub` at 41.67px and the `h1` below it at twice
// that. The size is asserted rather than the absence: dropping the entry prices
// the same heading at 100px, and a case pinning only silence would not have seen
// the difference between the two.
test('the size the default sheet gives a sub reaches the heading rule through the heading below it', async () => {
  const found = await staticFindings(
    page('section{font-size:50px}h1{font-size:2em}', `<section><sub><h1>${LONG_HEADING}</h1></sub></section>`),
    'oversized-h1'
  );
  assert.deepEqual(found, [`83px h1, 57 chars "${LONG_HEADING}"`]);
});

// The same position, at the other heading rule's own size anchor: a 32px section
// puts the `sub` at 26.67px and the italic serif `h1` at 53.33px.
test('the size the default sheet gives a sub reaches the italic serif rule through the heading below it', async () => {
  const found = await staticFindings(
    page(
      'section{font-size:32px}h1{font-size:2em;font-style:italic;font-family:Georgia,serif}',
      `<section><sub><h1>${LONG_HEADING}</h1></sub></section>`
    ),
    'italic-serif-display'
  );
  assert.deepEqual(found, [`italic serif h1 (georgia) at 53px "${LONG_HEADING}"`]);
});

// The inset rule's other arm. It fires on a bounded container whose children sit
// against the boundary, needs no rectangle, and resolves the inset against the
// font size — so 0.12em is 2.4px of a 20px section and clears the threshold, and
// 2px of the 16.67px a `sub` renders at does not.
test('the size the default sheet gives a sub is the basis the inset rule resolves a padding against', async () => {
  const found = await staticFindings(
    page(
      'section{font-size:20px}.card{border:1px solid #cc0000;padding:0.12em}',
      `<section><sub><div class="card"><p>${BODY_COPY}</p></div></sub></section>`
    ),
    'cramped-padding'
  );
  assert.deepEqual(found, ['<div> "card": children flush against border on all sides (no inset)']);
});

// The kicker rule admits a kicker only under 14px, and its tag allowlist decides
// what may BE one, not what may wrap one. Both the kicker and its heading sit
// inside the `sub` here and take their size through it: the kicker lands at
// 13.33px, under the ceiling, where the 16px it would otherwise be priced at is
// over.
test('the size the default sheet gives a sub reaches the kicker rule through the kicker below it', async () => {
  const sections = [1, 2, 3]
    .map(
      (n) =>
        '<section><sub><span style="text-transform:uppercase;letter-spacing:2px">SECTION LABEL</span>' +
        `<h2>Section heading number ${n}</h2></sub></section>`
    )
    .join('');
  const found = await staticFindings(page('section{font-size:16px}h2{font-size:1.5em}', sections), 'repeated-section-kickers');
  assert.deepEqual(found, [
    'repeated section kicker "SECTION LABEL" before h2 "Section heading number 1" (3 on page)',
    'repeated section kicker "SECTION LABEL" before h2 "Section heading number 2" (3 on page)',
    'repeated section kicker "SECTION LABEL" before h2 "Section heading number 3" (3 on page)',
  ]);
});

// The mirror of the tracking case, and the verdict the case list claimed to
// carry one of while carrying none. -0.9px is -0.045em of a 20px section and
// -0.054em of the 16.67px a `sub` renders at, and the floor between them is
// -0.05em.
test('the size the default sheet gives a sub is the basis the negative tracking rule divides by', async () => {
  const found = await staticFindings(
    page('section{font-size:20px}', `<section><sub><span style="letter-spacing:-0.9px">${BODY_COPY}</span></sub></section>`),
    'extreme-negative-tracking'
  );
  assert.deepEqual(found, [`letter-spacing: -0.05em — "${BODY_COPY.slice(0, 40)}"`]);
});
