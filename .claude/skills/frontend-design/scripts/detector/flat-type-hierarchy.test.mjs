/**
 * `flat-type-hierarchy` across both analysis engines.
 *
 * The rule id is emitted from two independent implementations — the helper in
 * `rules/checks.mjs`, reached by the static-HTML engine, and the regex engine's
 * own analyzer — so what one sees and the other does not is behaviour worth
 * pinning rather than an accident. Each case here drives one such difference:
 * the ones the engines were reconciled on, and the one they are deliberately
 * left apart on.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Nothing else
 * reaches them — `.claude/**` is outside every workspace glob, so no vitest
 * project, no ESLint config and no typecheck sees them. Run them on their own
 * with `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectText } from './engines/regex/detect-text.mjs';
import { detectHtml } from './engines/static-html/detect-html.mjs';

const RULE = 'flat-type-hierarchy';

/**
 * A full page, since both engines' page-level analyzers refuse anything without
 * a doctype, an `<html>` and a `<head>`. The `<img src="">` is an engine control
 * rather than decoration: it makes both engines emit `broken-image` on every
 * page here, so a silent `flat-type-hierarchy` verdict is a silent rule and not
 * an engine that never ran.
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

/** The engine control: the finding every page here produces from both engines. */
const CONTROL = 'broken-image';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-flat-type-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/** Run one page through both engines and return each one's `flat-type-hierarchy` snippets. */
/** @param {string} html */
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

test('the static cascade resolves rem, em and percentage font sizes to px', async () => {
  const found = await bothEngines(
    page(
      'body{font-size:16px}h1{font-size:1.125rem}h2{font-size:1.0625em}p{font-size:100%}',
      '<h1>a</h1><h2>b</h2><p>c</p>'
    )
  );
  assert.deepEqual(found.static, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

test('the static engine counts font sizes below 8px', async () => {
  const found = await bothEngines(
    page('h1{font-size:7.5px}h2{font-size:7px}p{font-size:6px}', '<h1>a</h1><h2>b</h2><p>c</p>')
  );
  assert.deepEqual(found.static, ['Sizes: 6px, 7px, 7.5px (ratio 1.3:1)']);
});

test('the static engine counts a Tailwind text-size class', async () => {
  const found = await bothEngines(
    page('', '<h1 class="text-3xl">a</h1><h2 class="text-2xl">b</h2><p class="text-xl">c</p>')
  );
  assert.deepEqual(found.static, ['Sizes: 20px, 24px, 30px (ratio 1.5:1)']);
});

test('both engines price a Tailwind text-size class the same', async () => {
  const found = await bothEngines(
    page('', '<h1 class="text-3xl">a</h1><h2 class="text-2xl">b</h2><p class="text-xl">c</p>')
  );
  assert.deepEqual(found.static, found.regex);
});

test('the static engine sizes the text elements the page font scan also visits', async () => {
  const found = await bothEngines(
    page(
      'figcaption{font-size:18px}blockquote{font-size:17px}dd{font-size:16px}',
      '<figure><figcaption>a</figcaption></figure><blockquote>b</blockquote><dl><dd>c</dd></dl>'
    )
  );
  assert.deepEqual(found.static, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

// `clamp(min, preferred, max)` renders as one size at any one viewport width, and
// the minimum is the size at the narrowest one — where flat type is least escapable.
// Both engines price that endpoint, so a page built on clamp() is reachable by this
// rule from either of them rather than by neither.
test('the static engine prices a clamp() font size at its minimum endpoint', async () => {
  const found = await bothEngines(
    page(
      'h1{font-size:clamp(20px, 4vw, 30px)}h2{font-size:22px}p{font-size:21px}span{font-size:17px}',
      '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
    )
  );
  assert.deepEqual(found.static, ['Sizes: 17px, 20px, 21px, 22px (ratio 1.3:1)']);
});

test('both engines price a clamp() font size the same', async () => {
  const found = await bothEngines(
    page(
      'h1{font-size:clamp(20px, 4vw, 30px)}h2{font-size:22px}p{font-size:21px}span{font-size:17px}',
      '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
    )
  );
  assert.deepEqual(found.regex, found.static);
});

// The case the maximum endpoint hides: 16-to-40 spans a 2.5:1 range no single
// rendering of this page shows, and reading it as one leaves a page that is flat
// at every width unflagged.
test('a page flat at every viewport under clamp() is flagged by both engines', async () => {
  const found = await bothEngines(
    page(
      'h1{font-size:clamp(16px, 4vw, 40px)}h2{font-size:18px}p{font-size:17px}',
      '<h1>a</h1><h2>b</h2><p>c</p>'
    )
  );
  assert.deepEqual(found.static, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
  assert.deepEqual(found.regex, found.static);
});

test('the static engine prices a clamp() font size given in rem at its minimum endpoint', async () => {
  const found = await bothEngines(
    page(
      'h1{font-size:clamp(1.25rem, 4vw, 3rem)}h2{font-size:22px}p{font-size:21px}span{font-size:17px}',
      '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
    )
  );
  assert.deepEqual(found.static, ['Sizes: 17px, 20px, 21px, 22px (ratio 1.3:1)']);
});

test('the static engine resolves a var() font size, so a steep hierarchy is not called flat', async () => {
  const found = await bothEngines(
    page(
      ':root{--big:64px}h1{font-size:var(--big)}h2{font-size:17px}p{font-size:16px}span{font-size:18px}',
      '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
    )
  );
  assert.deepEqual(found.static, []);
});

test('the regex engine reads past a var() font size, a divergence kept deliberately', async () => {
  const found = await bothEngines(
    page(
      ':root{--big:64px}h1{font-size:var(--big)}h2{font-size:17px}p{font-size:16px}span{font-size:18px}',
      '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>'
    )
  );
  assert.deepEqual(found.regex, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

// The second place the two engines read one page differently. The static
// engine's cascade models the size the browser's own default stylesheet gives a
// heading; the regex engine has no cascade and no element above to measure a
// multiple of, so a heading the page itself does not size is a size it cannot
// read. A real Chromium renders the `<h1>` in these cases at 32px against a
// 16px smallest size — a 2.0 ratio, outside this rule — and the page is
// therefore not flat. The static engine reaches that by pricing the heading;
// this engine reaches it by declining a range it has not read the top of, which
// is the only route to it open to a reader with no document.
const BARE_HEADING_STYLE = 'p{font-size:16px}li{font-size:17px}blockquote{font-size:18px}';
const BARE_HEADING_BODY =
  '<h1>a</h1><p>b</p><ul><li>c</li></ul><blockquote>d</blockquote>';

test('the static engine takes the size the default stylesheet gives a bare heading', async () => {
  const found = await bothEngines(page(BARE_HEADING_STYLE, BARE_HEADING_BODY));
  assert.deepEqual(found.static, []);
});

test('the regex engine reads no range off a page whose heading it could not size', async () => {
  const found = await bothEngines(page(BARE_HEADING_STYLE, BARE_HEADING_BODY));
  assert.deepEqual(found.regex, []);
});

// The bound the decline must not spend: a page that sizes its heading has a top
// this engine has read, and reads as flat when it is. Both spellings of sizing
// it are driven, because each is a separate branch of the reading — a rule the
// stylesheet states for the tag, and a size written on the element itself.
test('a heading the stylesheet sizes leaves the page readable by the regex engine', async () => {
  const found = await bothEngines(
    page(`h1{font-size:18px}${BARE_HEADING_STYLE}`, BARE_HEADING_BODY)
  );
  assert.deepEqual(found.regex, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

test('a heading sized on the element itself leaves the page readable by the regex engine', async () => {
  const found = await bothEngines(
    page(BARE_HEADING_STYLE, '<h1 style="font-size:18px">a</h1><p>b</p><ul><li>c</li></ul><blockquote>d</blockquote>')
  );
  assert.deepEqual(found.regex, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

// A heading below the first is the same reading: `h3` takes 1.17 times the size
// above it from the same sheet, so a page stating none of its own is a page
// whose range this engine has not read either.
test('the regex engine reads no range off a page whose third-level heading it could not size', async () => {
  const found = await bothEngines(
    page(BARE_HEADING_STYLE, '<h3>a</h3><p>b</p><ul><li>c</li></ul><blockquote>d</blockquote>')
  );
  assert.deepEqual(found.regex, []);
});

// The element carrying the class states no `font-size` of its own and the browser's
// default stylesheet states none for it either, so the class lookup is the branch under
// test: sized from anywhere else, the class would never be consulted and these cases
// would pass whatever the lookup did. A heading cannot carry it for that reason — the
// default sheet gives one 32px against the 16px here, a 2.0 ratio, outside this rule.
// Driven with the class back on an `<h1>` and the lookup left alone, the static engine
// answers nothing at all rather than the row asserted below; driven again with the
// lookup stripping the prefix, it answers `Sizes: 16px, 17px, 18px, 30px (ratio 1.9:1)`.
// Neither reading is the row these cases exist to pin.
test('the static engine prices no size for a variant-prefixed Tailwind class', async () => {
  const found = await bothEngines(
    page(
      'h2{font-size:17px}p{font-size:16px}span{font-size:18px}',
      '<div class="md:text-3xl">a</div><h2>b</h2><p>c</p><span>e</span>'
    )
  );
  assert.deepEqual(found.static, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

// The regex half of the same axis. `:` is a non-word character, so a pattern
// anchored on word boundaries alone matches `text-3xl` inside `md:text-3xl` and
// prices a size that applies only above a breakpoint.
test('the regex engine prices no size for a variant-prefixed Tailwind class', async () => {
  const found = await bothEngines(
    page(
      'h2{font-size:17px}p{font-size:16px}span{font-size:18px}',
      '<div class="md:text-3xl">a</div><h2>b</h2><p>c</p><span>e</span>'
    )
  );
  assert.deepEqual(found.regex, ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']);
});

test('both engines price a variant-prefixed Tailwind class the same', async () => {
  const found = await bothEngines(
    page(
      'h2{font-size:17px}p{font-size:16px}span{font-size:18px}',
      '<div class="md:text-3xl">a</div><h2>b</h2><p>c</p><span>e</span>'
    )
  );
  assert.deepEqual(found.regex, found.static);
});

test('an unprefixed Tailwind class beside a variant-prefixed one is still priced by the regex engine', async () => {
  const found = await bothEngines(
    page(
      'h2{font-size:17px}p{font-size:16px}',
      '<h1 class="text-xl md:text-3xl">a</h1><h2>b</h2><p>c</p>'
    )
  );
  assert.deepEqual(found.regex, ['Sizes: 16px, 17px, 20px (ratio 1.3:1)']);
});

test('a font size the cascade specified wins over a Tailwind class on the same element', async () => {
  const found = await bothEngines(
    page(
      'h1{font-size:48px}h2{font-size:17px}p{font-size:16px}',
      '<h1 class="text-xl">a</h1><h2>b</h2><p>c</p>'
    )
  );
  assert.deepEqual(found.static, []);
});

// ---------------------------------------------------------------------------
// What this engine prices, and what it declines to price
// ---------------------------------------------------------------------------

// The regex engine reads every font size through the same reducer the
// static-HTML engine's cascade uses, and asks it a different question. The
// cascade knows the parent size, so it prices `em` and `%` against a real one.
// This engine has none, so the basis it passes is a stand-in — and a reduction
// that consumed a stand-in is a size no rendering of the page shows. Whether a
// value REDUCES is the same answer at every basis and is what the unresolvable
// report asks; what it reduces TO is what a type scale asks, and that one
// declines the stand-in.
//
// Each case below straddles one boundary this reading moves, in both
// directions: a page that enters the rule because a fabricated size left the
// scale, and a page that leaves it because the fabricated size was a step.

/** Run one source through the regex engine alone, as the walker does for every
 *  type but HTML, and return its `flat-type-hierarchy` snippets. */
/** @param {string} source */
function regexOnly(source) {
  const file = path.join(scratch, `case-${++caseCount}.astro`);
  const found = detectText(source, file, {});
  assert.ok(
    found.some((f) => f.antipattern === CONTROL),
    'engine control: the regex engine must have run on this source'
  );
  return found.filter((f) => f.antipattern === RULE).map((f) => f.snippet);
}

const STEPS = '<h1>a</h1><h2>b</h2><p>c</p><span>d</span>';

test('an em font size enters no type scale, so the page it hid is read', () => {
  assert.deepEqual(
    regexOnly(
      page('h1{font-size:2em}h2{font-size:17px}p{font-size:16px}span{font-size:18px}', STEPS)
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('an em font size enters no type scale, so a page it was a step of is not read', () => {
  assert.deepEqual(
    regexOnly(page('h1{font-size:1.5em}h2{font-size:16px}p{font-size:18px}', STEPS)),
    []
  );
});

// A `clamp()` whose minimum is an `em` is the same value one layer in, and the
// reducer carries the basis through its own recursion rather than losing it at
// the endpoint.
test('a clamp() whose minimum is an em enters no type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:clamp(1.25em,4vw,3em)}h2{font-size:22px}p{font-size:21px}span{font-size:17px}',
        STEPS
      )
    ),
    ['Sizes: 17px, 21px, 22px (ratio 1.3:1)']
  );
});

// The percentage is the value that made the duplication visible: the analyzer's
// own pattern never matched one, so a page carrying it was priced as though it
// were not there. It is still not priced, and now for the reason rather than by
// the accident — a percentage of a stand-in is a fabricated size like any other.
test('a percentage font size is priced into no type scale', () => {
  assert.deepEqual(
    regexOnly(
      page('h1{font-size:200%}h2{font-size:17px}p{font-size:16px}span{font-size:18px}', STEPS)
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

// The scale is priced from the declaration walk, so what the walk declines the
// scale declines: a custom property's own definition is not a font-size
// declaration, and a value the reducer refuses is not a size.
test('a custom property definition enters no type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        ':root{--display-font-size:64px}h1{font-size:17px}h2{font-size:16px}p{font-size:18px}',
        STEPS
      )
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a page whose third step was a custom property definition leaves the rule', () => {
  assert.deepEqual(
    regexOnly(page(':root{--display-font-size:20px}h1{font-size:17px}h2{font-size:16px}', STEPS)),
    []
  );
});

// A preprocessor variable is a definition exactly as a custom property is, and
// a page that writes its scale in one — an `.astro` page whose `<style>` is
// Sass or Less — is a page this analyzer runs on. Both directions are driven
// for each sigil, because a definition priced as a size both invents a step
// where the page has none and holds a scale open that the page's own sizes
// close.
test('a Sass variable definition enters no type scale', () => {
  assert.deepEqual(
    regexOnly(page('$font-size:64px;h1{font-size:17px}h2{font-size:16px}p{font-size:18px}', STEPS)),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a Less variable definition enters no type scale', () => {
  assert.deepEqual(
    regexOnly(page('@font-size:64px;h1{font-size:17px}h2{font-size:16px}p{font-size:18px}', STEPS)),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a page whose third step was a Sass variable definition leaves the rule', () => {
  assert.deepEqual(
    regexOnly(page('$font-size:20px;h1{font-size:17px}h2{font-size:16px}', STEPS)),
    []
  );
});

test('a page whose third step was a Less variable definition leaves the rule', () => {
  assert.deepEqual(
    regexOnly(page('@font-size:20px;h1{font-size:17px}h2{font-size:16px}', STEPS)),
    []
  );
});

// A size a JavaScript chain writes is a size of the page. A zero-argument call
// in a chain (`.sort()`) stands after `)` rather than after a name character,
// so a reading that takes a name-preceded call plus the brace after it for a
// body under a name swallows the callback and drops every size inside it. The
// page here is flat and says so; the same page with the third size written
// outside the chain is the sibling below.
test('a size written inside a chained callback is a step of its type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:16px}h2{font-size:17px}',
        `${STEPS}<script>const m = Object.keys(o).sort().reduce((acc, k) => { acc[k] = \`font-size: 18px;\`; return acc; }, {});</script>`
      )
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a size written in a plain script is a step of its type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:16px}h2{font-size:17px}',
        `${STEPS}<script>const s = \`font-size: 18px;\`;</script>`
      )
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a font size the shared reducer refuses enters no type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:40px !important}h2{font-size:17px}p{font-size:16px}span{font-size:18px}',
        STEPS
      )
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a page whose third step is a font size the reducer refuses leaves the rule', () => {
  assert.deepEqual(
    regexOnly(page('h1{font-size:20px !important}h2{font-size:17px}p{font-size:16px}', STEPS)),
    []
  );
});

// The two spellings the walk gained price into the scale exactly as the
// stylesheet spelling does — which is the half of this change no ruling
// described: a declaration the hierarchy rule could not see is now a member of
// its population, and that both adds pages to the rule and removes them.
test('a presentation attribute font size is priced into the type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:16px}h2{font-size:16px}p{font-size:18px}',
        `<svg><text font-size="17">a</text></svg>${STEPS}`
      )
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a presentation attribute font size can widen the ratio past the rule', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:16px}h2{font-size:17px}p{font-size:18px}',
        `<svg><text font-size="40">a</text></svg>${STEPS}`
      )
    ),
    []
  );
});

test('a style object font size is priced into the type scale', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:16px}h2{font-size:16px}p{font-size:18px}',
        `<script>const s={fontSize:17};</script>${STEPS}`
      )
    ),
    ['Sizes: 16px, 17px, 18px (ratio 1.1:1)']
  );
});

test('a style object font size can widen the ratio past the rule', () => {
  assert.deepEqual(
    regexOnly(
      page(
        'h1{font-size:16px}h2{font-size:17px}p{font-size:18px}',
        `<script>const s={fontSize:40};</script>${STEPS}`
      )
    ),
    []
  );
});

// The static-HTML engine reads none of the three boundaries above differently,
// because its cascade answers the basis question for itself. Driven on the same
// bytes so the divergence is a measurement rather than an assumption.
test('the static engine prices an em font size against the parent its cascade resolved', async () => {
  const found = await bothEngines(
    page('h1{font-size:1.5em}h2{font-size:16px}p{font-size:18px}', STEPS)
  );
  assert.deepEqual(found.static, ['Sizes: 16px, 18px, 24px (ratio 1.5:1)']);
});

// The other half of the same page, and the divergence stated as a value: the
// size the cascade names is the one this engine has no parent to compute, so
// the two engines answer differently on the same bytes by design.
test('the regex engine names no size for the em the static engine priced', async () => {
  const found = await bothEngines(
    page('h1{font-size:1.5em}h2{font-size:16px}p{font-size:18px}', STEPS)
  );
  assert.deepEqual(found.regex, []);
});

test('a font size on the style attribute wins over a Tailwind class on the same element', async () => {
  const found = await bothEngines(
    page(
      'h2{font-size:17px}p{font-size:16px}',
      '<h1 class="text-xl" style="font-size:48px">a</h1><h2>b</h2><p>c</p>'
    )
  );
  assert.deepEqual(found.static, []);
});
