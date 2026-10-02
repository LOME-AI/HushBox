/**
 * The human-readable report names the engine behind each finding.
 *
 * The repository runs this file automatically. Which files it runs is decided
 * by node's own test-file naming convention over the skill tree, so a name
 * outside that convention drops out of the population without a word. Run it on
 * its own with `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ENGINE_REGEX, ENGINE_STATIC_HTML } from '../findings.mjs';
import { detectText } from '../engines/regex/detect-text.mjs';
import { detectHtml } from '../engines/static-html/detect-html.mjs';
import { formatFindings } from './main.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');
const PAGE = path.join(FIXTURES, 'marketing-page.html');
const STYLES = path.join(FIXTURES, 'component-styles.css');

/** The report's per-finding lines: the indented ones carrying a rule id. */
/**
 * @param {string} report
 * @returns {string[]}
 */
function findingLines(report) {
  return report.split('\n').filter((line) => /^ {2}(?:line \d+: )?\[/.test(line));
}

test('the text report names static-html on every static-HTML finding', async () => {
  const findings = await detectHtml(PAGE, {});
  assert.ok(findings.length > 0, 'positive control: the fixture page must produce findings');

  const lines = findingLines(formatFindings(findings, false));
  assert.equal(lines.length, findings.length);
  assert.deepEqual(
    lines.filter((line) => line.includes(ENGINE_STATIC_HTML)),
    lines
  );
});

test('the text report names regex on every regex finding', () => {
  const findings = detectText(fs.readFileSync(STYLES, 'utf-8'), STYLES, {});
  assert.ok(findings.length > 0, 'positive control: the fixture stylesheet must produce findings');

  const lines = findingLines(formatFindings(findings, false));
  assert.equal(lines.length, findings.length);
  assert.deepEqual(
    lines.filter((line) => line.includes(`(engine: ${ENGINE_REGEX})`)),
    lines
  );
});

test('the text report distinguishes two engines reporting the same rule on one file', async () => {
  const fromStatic = await detectHtml(PAGE, {});
  const fromRegex = detectText(fs.readFileSync(PAGE, 'utf-8'), PAGE, {});
  const shared = fromStatic
    .map((f) => f.antipattern)
    .filter((id) => fromRegex.some((f) => f.antipattern === id));
  assert.ok(shared.length > 0, 'positive control: the two engines must overlap on this page');

  const report = formatFindings([...fromStatic, ...fromRegex], false);
  const lines = findingLines(report).filter((line) => line.includes(`[${shared[0]}]`));
  assert.ok(
    lines.some((line) => line.includes(`(engine: ${ENGINE_STATIC_HTML})`)),
    `no static-html line for ${shared[0]}`
  );
  assert.ok(
    lines.some((line) => line.includes(`(engine: ${ENGINE_REGEX})`)),
    `no regex line for ${shared[0]}`
  );
});

test('the JSON report carries the engine field', async () => {
  const findings = await detectHtml(PAGE, {});
  assert.ok(findings.length > 0, 'positive control: the fixture page must produce findings');

  const parsed = /** @type {import('../findings.mjs').Finding[]} */ (
    JSON.parse(formatFindings(findings, true))
  );
  assert.deepEqual([...new Set(parsed.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
});
