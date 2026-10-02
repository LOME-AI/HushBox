/**
 * The size a utility class states, as every static-HTML rule that reads a size
 * sees it.
 *
 * The static cascade is built from the page's own stylesheets, and the utility
 * stylesheet is not among them — so on a page whose type scale is written in
 * classes the cascade resolves every element to one inherited default. Two
 * readers used to consult the class for themselves and the rest were blind to
 * it, which meant one rule pricing an element at the size the page states while
 * its neighbour priced the same element at 16px. The reading now sits in the
 * cascade, which writes the class size into the element's computed `font-size`
 * so the elements below inherit it, and every reader of a size — the walk those
 * rules share and the two rules that read a computed value instead — is
 * downstream of that one write.
 *
 * Each case here drives one rule across the boundary the reading moves, in the
 * direction that boundary moves it: a size the page states is not always
 * smaller or always larger than the one it inherits, so admitting it turns some
 * findings on and others off. Both directions are pinned, because a change
 * measured only where it adds findings is measured on half its population.
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
const LONG_BODY_COPY =
  'Body copy that is comfortably longer than fifty characters, long enough to clear the floor.';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-class-size-'));
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

test('an h1 sized only by a utility class is priced at that size', async () => {
  const found = await staticFindings(
    page('', `<h1 class="text-8xl">${LONG_HEADING}</h1>`),
    'oversized-h1'
  );
  assert.deepEqual(found, [`96px h1, 57 chars "${LONG_HEADING}"`]);
});

test('an h1 whose class states a smaller size than it inherits is priced at the class size', async () => {
  const found = await staticFindings(
    page('body{font-size:100px}', `<h1 class="text-sm">${LONG_HEADING}</h1>`),
    'oversized-h1'
  );
  assert.deepEqual(found, []);
});

test('a font size the cascade specified outranks a utility class on the same element', async () => {
  const found = await staticFindings(
    page('h1{font-size:80px}', `<h1 class="text-sm">${LONG_HEADING}</h1>`),
    'oversized-h1'
  );
  assert.deepEqual(found, [`80px h1, 57 chars "${LONG_HEADING}"`]);
});

test('a variant-prefixed utility class states no size for an h1', async () => {
  const found = await staticFindings(
    page('', `<h1 class="md:text-8xl">${LONG_HEADING}</h1>`),
    'oversized-h1'
  );
  assert.deepEqual(found, []);
});

test('an italic serif h1 sized only by a utility class reaches the display threshold', async () => {
  const found = await staticFindings(
    page(
      'h1{font-style:italic;font-family:Georgia,serif}',
      '<h1 class="text-5xl">Serif display heading</h1>'
    ),
    'italic-serif-display'
  );
  assert.deepEqual(found, ['italic serif h1 (georgia) at 48px "Serif display heading"']);
});

test('an eyebrow sized only by a utility class is read at that size', async () => {
  const found = await staticFindings(
    page(
      'p.eyebrow{text-transform:uppercase;letter-spacing:2px}',
      '<p class="eyebrow text-xs">Introducing</p><h1>The headline</h1>'
    ),
    'hero-eyebrow-chip'
  );
  assert.deepEqual(found, ['eyebrow chip (tracked-caps) "Introducing" above h1 "The headline"']);
});

test('an eyebrow whose class states a size above the eyebrow gate is not an eyebrow', async () => {
  const found = await staticFindings(
    page(
      'body{font-size:12px}p.eyebrow{text-transform:uppercase;letter-spacing:2px}',
      '<p class="eyebrow text-lg">Introducing</p><h1>The headline</h1>'
    ),
    'hero-eyebrow-chip'
  );
  assert.deepEqual(found, []);
});

test('section kickers sized only by a utility class are read at that size', async () => {
  const block = '<div><p class="kick text-xs">FEATURES</p><h2>Section heading</h2></div>';
  const found = await staticFindings(
    page(
      'h2{font-size:24px}p.kick{text-transform:uppercase;letter-spacing:2px}',
      block + block + block
    ),
    'repeated-section-kickers'
  );
  assert.equal(found.length, 3);
});

test('tracking is measured against the size a utility class states', async () => {
  const found = await staticFindings(
    page('p{letter-spacing:0.7px}', `<p class="text-xs">${BODY_COPY}</p>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

test('tracking wide against an inherited size is narrow against the size the class states', async () => {
  const found = await staticFindings(
    page('p{letter-spacing:1px}', `<p class="text-3xl">${BODY_COPY}</p>`),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

// The class reading lives in the parent walk rather than at the element the rule
// visits, so it survives a descendant whose own declaration the cascade could
// not reduce. Reading the class at the visited element alone would leave this
// span at the root default, which is a size no rendering of the page shows.
test('an ancestor class states the size of a descendant the cascade left verbatim', async () => {
  const found = await staticFindings(
    page(
      'span.v{font-size:4vw;letter-spacing:1px}',
      `<h1 class="text-8xl"><span class="v">${BODY_COPY}</span></h1>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// A value the cascade resolves before a rule reads it
// ---------------------------------------------------------------------------
//
// A rule reading a ratio is given two numbers from two places: the size from the
// class-aware walk, and the value the cascade stored for the element. The cascade
// stores it in the form the element reading it prices correctly, so the ratio a
// rule computes is the one a browser renders. The pairs below drive that
// boundary in both directions on each rule that reads such a ratio, because a size
// a class states is not always larger than the one an element inherits: the same
// cause turns findings on where the class is smaller and off where it is larger,
// and a fix measured only where it silences findings is measured on half its
// population.

test('an em tracking that stays under the wide-tracking floor at the class size is not reported', async () => {
  const found = await staticFindings(
    page('p{letter-spacing:0.04em}', `<p class="text-xs">${BODY_COPY}</p>`),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

test('an em tracking that clears the wide-tracking floor at the class size is reported', async () => {
  const found = await staticFindings(
    page('p{letter-spacing:0.09em}', `<p class="text-3xl">${BODY_COPY}</p>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.09em on body text']);
});

test('an em tracking that stays above the crushed-tracking floor at the class size is not reported', async () => {
  const found = await staticFindings(
    page('p{letter-spacing:-0.04em}', `<p class="text-xs">${BODY_COPY}</p>`),
    'extreme-negative-tracking'
  );
  assert.deepEqual(found, []);
});

test('an em tracking that falls below the crushed-tracking floor at the class size is reported', async () => {
  const found = await staticFindings(
    page('p{letter-spacing:-0.09em}', `<p class="text-3xl">${BODY_COPY}</p>`),
    'extreme-negative-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: -0.09em — "Body copy that is comfortably longer tha"']);
});

test('a unitless line-height is measured against the size a utility class states', async () => {
  const found = await staticFindings(
    page('p{line-height:1.5}', `<p class="text-3xl">${LONG_BODY_COPY}</p>`),
    'tight-leading'
  );
  assert.deepEqual(found, []);
});

test('a leading tight at the size a utility class states is reported', async () => {
  const found = await staticFindings(
    page('p{line-height:1.2}', `<p class="text-xs">${LONG_BODY_COPY}</p>`),
    'tight-leading'
  );
  assert.deepEqual(found, ['line-height 1.20x (need >=1.3)']);
});

// A unitless `line-height` inherits as the multiple rather than as the length
// it makes: every element under the declaration renders it against its own
// size, so an element whose size a class states renders a different leading
// from the one that declared it. It is not the only value that does — a
// `letter-spacing` percentage is the other, and both are named in
// `RATIO_INHERITED_FORM` in
// `.claude/skills/frontend-design/scripts/detector/engines/static-html/css-cascade.mjs`.
test('a unitless line-height inherited from an ancestor is measured against the size the element itself uses', async () => {
  const found = await staticFindings(
    page('body{line-height:1.5}', `<p class="text-3xl">${LONG_BODY_COPY}</p>`),
    'tight-leading'
  );
  assert.deepEqual(found, []);
});

// The other half of the same boundary: an `em` font size resolves against the
// size its PARENT uses, which is the size a class states there. A rule reading
// the size itself rather than a ratio is what shows it, because the ratio a rule
// computes from a wrong basis can still be right while the size never is.
test('an em font size under a class resolves against the size the class states', async () => {
  const found = await staticFindings(
    page('', `<div class="text-8xl"><p style="font-size:0.3em">${LONG_BODY_COPY}</p></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('an em font size under a small class leaves the element under the tiny-text floor', async () => {
  const found = await staticFindings(
    page('', `<div class="text-xs"><p style="font-size:0.75em">${LONG_BODY_COPY}</p></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['9px body text']);
});

// ---------------------------------------------------------------------------
// The element that DECLARES a relative value and the element that READS it
// ---------------------------------------------------------------------------
//
// A relative value is a length at the size of the element that declared it and a
// ratio at the size of the element that reads it, and those are two sizes
// whenever anything between them changes size. Every case below therefore
// separates the two elements, so a value reduced against the wrong one of them
// shows. Each expectation is the ratio a browser renders, computed from the
// case's own sizes.

test('an em tracking on a class-sized ancestor is read at the ratio that ancestor renders', async () => {
  const found = await staticFindings(
    page('', `<div class="text-3xl" style="letter-spacing:0.04em"><p>${LONG_BODY_COPY}</p></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

test('an em tracking on a small class-sized ancestor is reported at the ratio it renders', async () => {
  const found = await staticFindings(
    page('', `<div class="text-xs" style="letter-spacing:0.06em"><p>${LONG_BODY_COPY}</p></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

test('an em leading on a class-sized ancestor is read at the ratio that ancestor renders', async () => {
  const found = await staticFindings(
    page('', `<div class="text-3xl" style="line-height:0.5em"><p>${LONG_BODY_COPY}</p></div>`),
    'tight-leading'
  );
  assert.deepEqual(found, ['line-height 0.50x (need >=1.3)']);
});

test('a leading tight at the size a class-sized ancestor renders is reported', async () => {
  const found = await staticFindings(
    page('', `<div class="text-3xl" style="line-height:1.2em"><p>${LONG_BODY_COPY}</p></div>`),
    'tight-leading'
  );
  assert.deepEqual(found, ['line-height 1.20x (need >=1.3)']);
});

test('a percentage leading on a class-sized ancestor is read at the ratio that ancestor renders', async () => {
  const found = await staticFindings(
    page('', `<div class="text-3xl" style="line-height:120%"><p>${LONG_BODY_COPY}</p></div>`),
    'tight-leading'
  );
  assert.deepEqual(found, ['line-height 1.20x (need >=1.3)']);
});

// The same boundary with an absolute length rather than a relative one: the
// pixels the ancestor fixes are a small fraction of the size it renders at, and
// the reader renders at that same size.
test('an absolute tracking on a class-sized ancestor is read at the ratio that ancestor renders', async () => {
  const found = await staticFindings(
    page('', `<div class="text-3xl" style="letter-spacing:1px"><p>${LONG_BODY_COPY}</p></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

// The declaring element inherits the class size rather than carrying the class,
// so the length it fixes is a fraction of the inherited size and the reader
// states a size of its own to divide it by.
test('a reader that states its own size prices a tracking declared on an element that inherits a class size', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div class="text-3xl"><div style="letter-spacing:0.02em"><p style="font-size:10px">${LONG_BODY_COPY}</p></div></div>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

// The declaration sits above the class, so the length it fixes is a fraction of
// the size the page states there, not of the class size the reader renders at.
test('a tracking declared above a class-sized ancestor is read at the ratio the reader renders', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div style="letter-spacing:0.09em"><span class="text-3xl"><p>${LONG_BODY_COPY}</p></span></div>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

test('a tracking crossing two class-stated sizes is read at the ratio the nearer one renders', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div class="text-3xl" style="letter-spacing:0.025em"><div class="text-sm"><p>${LONG_BODY_COPY}</p></div></div>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.05em on body text']);
});

// The reader states its own size, so it is read at the size it renders and the
// inherited length is priced against it exactly as a browser does. Reducing the
// declaration at the class-sized element it sits on is what makes that work, so
// this case is the one a fix that stopped reducing there would break.
test('a reader that states its own size prices a tracking declared on the class-sized element above it', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div class="text-3xl" style="letter-spacing:0.04em"><p style="font-size:10px">${LONG_BODY_COPY}</p></div>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.12em on body text']);
});

// ---------------------------------------------------------------------------
// The value that inherits as a LENGTH and the value that inherits as a RATIO
// ---------------------------------------------------------------------------
//
// A `letter-spacing` written as a percentage does not compute to a length: it
// inherits as the percentage and re-resolves against every descendant's own font
// size, so the ratio it renders is the percentage itself at every element under
// it. Reducing it once, where it is declared, hands every descendant below a size
// change a ratio no rendering of the page produces — in both directions. Every
// other reducible value of these two properties computes to a length at the
// element that declares it, and the last case below is one of those: it is the
// case a fix that carried percentages as ratios everywhere would break.

test('a percentage tracking is read at the size the element reading it renders', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div style="letter-spacing:3%"><div><p style="font-size:0.5em">${LONG_BODY_COPY}</p></div></div>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, []);
});

test('a percentage tracking above a larger reading element is reported at the ratio that element renders', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div style="font-size:8px;letter-spacing:9%"><p style="font-size:32px">${LONG_BODY_COPY}</p></div>`
    ),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.09em on body text']);
});

// Green before and after, and discriminating in both trees: a class-stated size
// already reached the reader through the ratio form, so this is the case that
// says the percentage now reaching it unreduced is read at the same ratio rather
// than at a second one.
test('a percentage tracking on a class-sized ancestor is read at the percentage it states', async () => {
  const found = await staticFindings(
    page('', `<div class="text-3xl" style="letter-spacing:6%"><p>${LONG_BODY_COPY}</p></div>`),
    'wide-tracking'
  );
  assert.deepEqual(found, ['letter-spacing: 0.06em on body text']);
});

test('a negative percentage tracking above a larger reading element is reported at the ratio that element renders', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div style="font-size:8px;letter-spacing:-9%"><p style="font-size:32px">${LONG_BODY_COPY}</p></div>`
    ),
    'extreme-negative-tracking'
  );
  assert.deepEqual(found, [`letter-spacing: -0.09em — "${LONG_BODY_COPY.slice(0, 40)}"`]);
});

// The length side of the same split, and the guard on the fix above: a
// percentage `line-height` DOES compute to a length where it is declared, so the
// reading element renders the leading its ancestor computed rather than its own
// size times the percentage.
test('a percentage leading is read at the length it computed to on the element that declared it', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div style="font-size:40px;line-height:120%"><p style="font-size:80px">${LONG_BODY_COPY}</p></div>`
    ),
    'tight-leading'
  );
  assert.deepEqual(found, ['line-height 0.60x (need >=1.3)']);
});

// ---------------------------------------------------------------------------
// The size a class states, at the elements BELOW the one carrying the class
// ---------------------------------------------------------------------------
//
// A font size inherits, so the size a class states is the size of every
// descendant that states none of its own — and the size an `em` or a percentage
// on such a descendant resolves against. Each case below therefore puts at
// least one element between the class and the element the rule reads, because
// that gap is where a size that reaches only the class-carrying element is
// visible at all.
//
// The cases are grouped by WHERE the size comes from, which is a closed set: the
// document's initial size, a utility class, the element's own declaration
// reduced to pixels, its own declaration the reducer cannot price, an SVG
// presentation attribute, an explicit `inherit`, and inheritance itself. Only
// the class member was ever lost on the way down, so the rest are guards — but
// they are the guards that say a fix reaching them too would be wrong.
//
// Every expectation is a Chromium reading of the same markup with the utility
// stylesheet present, not a number derived from the engine.

test('a size a class states reaches a descendant that resolves an em against it', async () => {
  const found = await staticFindings(
    page('', `<div class="text-8xl"><div><p style="font-size:0.5em">${LONG_BODY_COPY}</p></div></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

// The mirror direction. A fix measured only where it silences a finding is
// measured on half its population, so the same shape runs with the class
// smaller than the size the page would otherwise inherit.
test('a small size a class states leaves a descendant resolving an em against it under the tiny-text floor', async () => {
  const found = await staticFindings(
    page('', `<div class="text-xs"><div><p style="font-size:0.75em">${LONG_BODY_COPY}</p></div></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['9px body text']);
});

// Stating the inherited value reaches the cascade as a declaration rather than
// as an absence, which is a different input to the same step.
test('a size a class states reaches a descendant through an explicit inherit', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div class="text-xs"><div style="font-size:inherit"><p style="font-size:0.75em">${LONG_BODY_COPY}</p></div></div>`
    ),
    'tiny-text'
  );
  assert.deepEqual(found, ['9px body text']);
});

// A presentation attribute loses to any author rule, so the class states this
// element's size and the attribute states none of it — including for the
// element below, which a browser renders at the class size.
test('a size a class states outranks an svg presentation attribute for the elements below it', async () => {
  const found = await staticFindings(
    page('', `<svg><text class="text-8xl" font-size="10"><tspan>${LONG_BODY_COPY}</tspan></text></svg>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

test('an svg presentation attribute with no class above it states the size of the element below', async () => {
  const found = await staticFindings(
    page('', `<svg><text font-size="10"><tspan>${LONG_BODY_COPY}</tspan></text></svg>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['10px body text']);
});

// The eyebrow rule reads its sibling's size off the computed value rather than
// through the parent walk, so it is the case that says the size inherits in the
// cascade and not only in the walk.
test('an eyebrow inheriting the size a class states is read at that size', async () => {
  const found = await staticFindings(
    page(
      'body{font-size:20px}p.eyebrow{text-transform:uppercase;letter-spacing:2px}',
      '<div class="text-xs"><p class="eyebrow">Introducing</p><h1>The headline</h1></div>'
    ),
    'hero-eyebrow-chip'
  );
  assert.deepEqual(found, ['eyebrow chip (tracked-caps) "Introducing" above h1 "The headline"']);
});

// The third reader of a size, and the only one that reads a POPULATION of them:
// a descendant priced at the size it inherits rather than at the class size puts
// a step in the type scale that the page never renders.
test('the type-hierarchy reading prices a descendant at the size a class states above it', async () => {
  const found = await staticFindings(
    page(
      'h1{font-size:14px}h2{font-size:20px}',
      `<h1>Alpha heading</h1><h2>Beta heading</h2><section class="text-8xl"><p>${LONG_BODY_COPY}</p></section>`
    ),
    'flat-type-hierarchy'
  );
  assert.deepEqual(found, []);
});

// The size also picks which contrast bar a colour is judged against, and 96px
// text clears the large-text bar that 16px text does not.
test('a descendant inheriting a large class size is judged at the large-text contrast bar', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div class="text-8xl" style="background:#ffffff"><p style="color:#8c8c8c">${LONG_BODY_COPY}</p></div>`
    ),
    'low-contrast'
  );
  assert.deepEqual(found, []);
});

test('a descendant inheriting the document size is judged at the normal-text contrast bar', async () => {
  const found = await staticFindings(
    page(
      '',
      `<div style="background:#ffffff"><p style="color:#8c8c8c">${LONG_BODY_COPY}</p></div>`
    ),
    'low-contrast'
  );
  assert.deepEqual(found, ['3.4:1 (need 4.5:1) — text #8c8c8c on #ffffff']);
});

test('the document size reaches a descendant that resolves an em against it', async () => {
  const found = await staticFindings(
    page('', `<div><div><p style="font-size:0.5em">${LONG_BODY_COPY}</p></div></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, ['8px body text']);
});

test('a size an element declares in pixels reaches a descendant that resolves an em against it', async () => {
  const found = await staticFindings(
    page('', `<div style="font-size:96px"><div><p style="font-size:0.5em">${LONG_BODY_COPY}</p></div></div>`),
    'tiny-text'
  );
  assert.deepEqual(found, []);
});

// The size the engine could not read is still the finding, and the elements
// under it are still left at the size they inherit rather than at an invented
// one: a browser resolves `4vw` against a viewport this engine has none of.
test('a declared size the reducer cannot price is reported rather than passed down as pixels', async () => {
  const found = await staticFindings(
    page('', `<div style="font-size:4vw"><div><p>${LONG_BODY_COPY}</p></div></div>`),
    'unresolvable-font-size'
  );
  assert.deepEqual(found, ['font-size: 4vw']);
});
