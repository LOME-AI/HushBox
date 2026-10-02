/**
 * The engine stamp, driven across both analysis engines on one input.
 *
 * The repository runs these files automatically. Which files it runs is decided
 * by node's own test-file naming convention over the skill tree, so a name
 * outside that convention drops out of the population without a word. Nothing
 * else reaches them: `.claude/**` is outside every workspace glob, so no vitest
 * project, no ESLint config and no typecheck sees them. Run them on their own
 * with `node --test` from the repository root.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ENGINE_REGEX, ENGINE_STATIC_HTML } from './findings.mjs';
import { RULE_ENGINE_SUPPORT } from './registry/antipatterns.mjs';
import { detectText } from './engines/regex/detect-text.mjs';
import { detectHtml } from './engines/static-html/detect-html.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures');
const PAGE = path.join(FIXTURES, 'marketing-page.html');
const STYLES = path.join(FIXTURES, 'component-styles.css');

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join('/');

/** A finding as the verdict baseline records it: rule id, file, line — no stamp. */
/** @param {import('./findings.mjs').Finding} f */
function triple(f) {
  return `${f.antipattern}|${toPosix(f.file).replace(toPosix(FIXTURES), '<fixtures>')}|${f.line}`;
}

/** @param {readonly import('./findings.mjs').Finding[]} findings */
function ruleIds(findings) {
  return [...new Set(findings.map((f) => f.antipattern))].sort();
}

test('the two engine ids are the ones the antipattern registry names', () => {
  assert.deepEqual(
    [ENGINE_REGEX, ENGINE_STATIC_HTML].filter((id) => id in RULE_ENGINE_SUPPORT).sort(),
    [ENGINE_REGEX, ENGINE_STATIC_HTML].sort()
  );
});

test('the static-HTML engine stamps every finding it emits', async () => {
  const findings = await detectHtml(PAGE, {});
  assert.ok(findings.length > 0, 'positive control: the fixture page must produce findings');
  assert.ok(ruleIds(findings).length > 1, 'positive control: more than one rule must fire');
  assert.deepEqual([...new Set(findings.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
});

test('the regex engine stamps every finding it emits', () => {
  const findings = detectText(fs.readFileSync(STYLES, 'utf-8'), STYLES, {});
  assert.ok(findings.length > 0, 'positive control: the fixture stylesheet must produce findings');
  assert.ok(ruleIds(findings).length > 1, 'positive control: more than one rule must fire');
  assert.deepEqual([...new Set(findings.map((f) => f.engine))], [ENGINE_REGEX]);
});

test('one input run through both engines carries a different stamp per engine', async () => {
  const html = fs.readFileSync(PAGE, 'utf-8');
  const fromStatic = await detectHtml(PAGE, {});
  const fromRegex = detectText(html, PAGE, {});

  assert.ok(fromStatic.length > 0, 'positive control: static-HTML must fire on this page');
  assert.ok(fromRegex.length > 0, 'positive control: regex must fire on this page');
  assert.deepEqual([...new Set(fromStatic.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
  assert.deepEqual([...new Set(fromRegex.map((f) => f.engine))], [ENGINE_REGEX]);
});

test('a rule both engines report is stamped with the engine that reported it', async () => {
  const html = fs.readFileSync(PAGE, 'utf-8');
  const fromStatic = await detectHtml(PAGE, {});
  const fromRegex = detectText(html, PAGE, {});
  const shared = ruleIds(fromStatic).filter((id) => ruleIds(fromRegex).includes(id));
  assert.ok(shared.length > 0, 'positive control: the two engines must overlap on this page');

  for (const id of shared) {
    assert.deepEqual(
      fromStatic.filter((f) => f.antipattern === id).map((f) => f.engine),
      fromStatic.filter((f) => f.antipattern === id).map(() => ENGINE_STATIC_HTML),
      `static-HTML stamp on ${id}`
    );
    assert.deepEqual(
      fromRegex.filter((f) => f.antipattern === id).map((f) => f.engine),
      fromRegex.filter((f) => f.antipattern === id).map(() => ENGINE_REGEX),
      `regex stamp on ${id}`
    );
  }
});

test('a rule only one engine reports is still stamped with that engine', async () => {
  const html = fs.readFileSync(PAGE, 'utf-8');
  const fromStatic = await detectHtml(PAGE, {});
  const fromRegex = detectText(html, PAGE, {});
  const onlyStatic = ruleIds(fromStatic).filter((id) => !ruleIds(fromRegex).includes(id));
  const onlyRegex = ruleIds(fromRegex).filter((id) => !ruleIds(fromStatic).includes(id));
  assert.ok(
    onlyStatic.length > 0,
    'positive control: static-HTML must find something regex does not'
  );
  assert.ok(
    onlyRegex.length > 0,
    'positive control: regex must find something static-HTML does not'
  );

  for (const f of fromStatic.filter((f) => onlyStatic.includes(f.antipattern))) {
    assert.equal(f.engine, ENGINE_STATIC_HTML, f.antipattern);
  }
  for (const f of fromRegex.filter((f) => onlyRegex.includes(f.antipattern))) {
    assert.equal(f.engine, ENGINE_REGEX, f.antipattern);
  }
});

test('both engines stamp on the path that skips inline ignores', async () => {
  const options = { inlineIgnores: false };
  const fromStatic = await detectHtml(PAGE, options);
  const fromRegex = detectText(fs.readFileSync(STYLES, 'utf-8'), STYLES, options);

  assert.ok(fromStatic.length > 0, 'positive control: static-HTML must fire on this page');
  assert.ok(fromRegex.length > 0, 'positive control: regex must fire on this stylesheet');
  assert.deepEqual([...new Set(fromStatic.map((f) => f.engine))], [ENGINE_STATIC_HTML]);
  assert.deepEqual([...new Set(fromRegex.map((f) => f.engine))], [ENGINE_REGEX]);
});

test('the corpus verdict matches the baseline recorded before the stamp existed', async () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'verdict-baseline.json'), 'utf-8')
  );
  const actual = {
    'detectHtml/marketing-page.html': (await detectHtml(PAGE, {})).map(triple).sort(),
    'detectText/marketing-page.html': detectText(fs.readFileSync(PAGE, 'utf-8'), PAGE, {})
      .map(triple)
      .sort(),
    'detectText/component-styles.css': detectText(fs.readFileSync(STYLES, 'utf-8'), STYLES, {})
      .map(triple)
      .sort(),
  };
  assert.deepEqual(actual, baseline);
});
