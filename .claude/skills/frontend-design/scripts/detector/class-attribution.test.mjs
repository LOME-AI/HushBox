/**
 * Which element a utility class names, and the two engines answering it alike.
 *
 * `ai-color-palette` and `gray-on-color` are each written twice — once over a
 * resolved element's class list, once over a source line — and the two readings
 * disagreed on the same markup in two ways. They phrased one verdict
 * differently: a purple gradient answered `Purple/violet gradient (Tailwind)`
 * from the element reading and `from-purple-500 gradient` from the source
 * reading. And they scoped it differently: the element reading asks which
 * element carries both utilities, the source reading asked only whether both
 * appear on one line, so two utilities written on SIBLING elements were a
 * finding from one engine and silence from the other.
 *
 * Both are settled the same way, and the element is the answer. A gradient's
 * two stops are one element's own background: `from-purple-500` on one element
 * and `to-blue-500` on its neighbour paint no gradient in any rendering, so the
 * line reading has no case it is right about and a sibling pair it is wrong
 * about. What a line reading is really keyed on is where the source's line
 * breaks fell — reflow the same markup and its answer moves, where a browser's
 * does not. So a class is attributed to the element whose tag the source writes
 * it in, and where the source writes it inside no tag — a stylesheet, or a call
 * that builds a class list — it names no element and the reach is unchanged.
 *
 * The phrasing that survives is the one that names the class, because that is
 * what the neighbouring verdicts in this family already name in both engines
 * (`text-purple-500 on heading`, `text-gray-500 on bg-blue-500`) and it is what
 * the author edits.
 *
 * WHAT THIS COSTS, stated because it is a real reading given up: a coloured
 * background an ANCESTOR carries and gray text a descendant carries is gray on
 * colour, and the source reading used to report it whenever both elements
 * happened to be written on one line. That was the same coin flip on formatting
 * from the other side — the same markup across two lines was already silent —
 * and where a document exists it is the element reading's resolved cascade that
 * answers the ancestor question properly.
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

/** The finding every source here carries, so a silent verdict is a silent rule
 *  rather than an engine that never read the source. */
const CONTROL = 'broken-image';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-class-attribution-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/** @param {string} body */
function page(body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body>${body}<img src=""></body></html>`;
}

/**
 * What the source reading reports for one rule. The engine is asserted because
 * a `.tsx` source is the population this engine is the reader for.
 * @param {string} body
 * @param {string} rule
 */
function fromSourceReading(body, rule) {
  const findings = detectText(page(body), 'page.tsx', {});
  assert.deepEqual(
    [...new Set(findings.map((f) => f.engine))],
    [ENGINE_REGEX],
    'engine control: the regex engine must be the one that answered'
  );
  assert.ok(findings.some((f) => f.antipattern === CONTROL), 'engine control: the control must report');
  return findings.filter((f) => f.antipattern === rule).map((f) => f.snippet);
}

/**
 * What the element reading reports for one rule. The engine stamp is asserted
 * because this engine loads its parsers by bare specifier and falls back to the
 * source reading without an error when they do not resolve — which would answer
 * a question about two engines with one of them twice.
 * @param {string} body
 * @param {string} rule
 */
async function fromElementReading(body, rule) {
  const file = path.join(scratch, `case-${++caseCount}.html`);
  fs.writeFileSync(file, page(body), 'utf8');
  const findings = await detectHtml(file, {});
  assert.deepEqual(
    [...new Set(findings.map((f) => f.engine))],
    [ENGINE_STATIC_HTML],
    'engine control: the static-HTML engine must be the one that answered'
  );
  assert.ok(findings.some((f) => f.antipattern === CONTROL), 'engine control: the control must report');
  return findings.filter((f) => f.antipattern === rule).map((f) => f.snippet);
}

// ─── One element carries both utilities: both engines report, in one phrasing ─

test('both engines phrase a gradient one element carries as the class that states it', async () => {
  const body = '<div class="bg-gradient-to-r from-purple-500 to-blue-500">Panel copy.</div>';
  assert.deepEqual(fromSourceReading(body, 'ai-color-palette'), ['from-purple-500 gradient']);
  assert.deepEqual(await fromElementReading(body, 'ai-color-palette'), ['from-purple-500 gradient']);
});

test('both engines phrase gray text one element carries on its own colour alike', async () => {
  const body = '<div class="text-gray-500 bg-blue-500">Panel copy.</div>';
  assert.deepEqual(fromSourceReading(body, 'gray-on-color'), ['text-gray-500 on bg-blue-500']);
  assert.deepEqual(await fromElementReading(body, 'gray-on-color'), ['text-gray-500 on bg-blue-500']);
});

test('both engines report a purple heading class the same way', async () => {
  const body = '<h1 class="text-purple-500">Title</h1>';
  assert.deepEqual(fromSourceReading(body, 'ai-color-palette'), ['text-purple-500 on heading']);
  assert.deepEqual(await fromElementReading(body, 'ai-color-palette'), ['text-purple-500 on heading']);
});

// ─── Sibling elements carry one utility each: no element carries the pair ────

const SIBLING_SHAPES = /** @type {const} */ ([
  ['one line', ''],
  ['two lines', '\n'],
]);

for (const [arrangement, separator] of SIBLING_SHAPES) {
  test(`neither engine reads a gradient off sibling elements written on ${arrangement}`, async () => {
    const body = `<div class="from-purple-500">a</div>${separator}<div class="to-blue-500">b</div>`;
    assert.deepEqual(fromSourceReading(body, 'ai-color-palette'), []);
    assert.deepEqual(await fromElementReading(body, 'ai-color-palette'), []);
  });

  test(`neither engine reads gray on colour off sibling elements written on ${arrangement}`, async () => {
    const body = `<div class="text-gray-500">a</div>${separator}<div class="bg-blue-500">b</div>`;
    assert.deepEqual(fromSourceReading(body, 'gray-on-color'), []);
    assert.deepEqual(await fromElementReading(body, 'gray-on-color'), []);
  });

  test(`neither engine reads a purple heading class off sibling elements written on ${arrangement}`, async () => {
    const body = `<h1>Title</h1>${separator}<span class="text-purple-500">note</span>`;
    assert.deepEqual(fromSourceReading(body, 'ai-color-palette'), []);
    assert.deepEqual(await fromElementReading(body, 'ai-color-palette'), []);
  });
}

// ─── The bound: a source that names no element keeps the reach it had ────────
//
// A call that builds a class list writes the utilities inside no tag, so there
// is no element to narrow to and nothing to attribute them to but the text as
// given. Narrowing here would report nothing on the population this engine
// exists for, which is worse than the sibling over-report it replaces.

test('the source reading still reads a gradient off a class list built in a call', () => {
  const source = `const cls = clsx('from-purple-500', 'to-blue-500');\n<img src="">`;
  const findings = detectText(source, 'panel.tsx', {});
  assert.ok(findings.some((f) => f.antipattern === CONTROL), 'engine control: the control must report');
  assert.deepEqual(
    findings.filter((f) => f.antipattern === 'ai-color-palette').map((f) => f.snippet),
    ['from-purple-500 gradient']
  );
});
