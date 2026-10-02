/**
 * What the report does with the findings the engines hand it.
 *
 * Three things happen here and nowhere else, because each is about the stream a
 * reader sees rather than about what any one engine found: a row that reports
 * what the detector could not read is separated from the anti-patterns, an
 * identical row is printed once, and the engine behind each row stays named.
 *
 * The repository runs this file automatically; which files it runs is decided
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ENGINE_REGEX, ENGINE_STATIC_HTML } from '../findings.mjs';
import { getAntipattern } from '../registry/antipatterns.mjs';
import { dedupeFindings } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', '..', 'detect.mjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-report-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let caseCount = 0;

/**
 * Run the real command line over a directory holding exactly these files, and
 * return what each of its two channels carried. The directory is outside any
 * project, so no config and no design system reaches the run.
 * @param {Record<string, string>} files
 */
function detect(files) {
  const root = path.join(scratch, `case-${++caseCount}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content, 'utf-8');
  }
  const result = spawnSync(process.execPath, [ENTRY, '--json', '.'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    findings: /** @type {import('../findings.mjs').Finding[]} */ (JSON.parse(result.stdout)),
  };
}

/**
 * Run the real command line over one named path inside a directory holding
 * exactly these files. Naming a path is the caller saying that path is the
 * subject, which is a different question from asking what a directory holds.
 * @param {Record<string, string>} files
 * @param {string} target
 */
function detectTarget(files, target) {
  const root = path.join(scratch, `case-${++caseCount}`);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  const result = spawnSync(process.execPath, [ENTRY, '--json', target], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    findings: /** @type {import('../findings.mjs').Finding[]} */ (JSON.parse(result.stdout)),
  };
}

/** A stylesheet the engines always find something in, so a silent rule is not a
 *  silent run. */
const CONTROL_CSS = '.sidebar { border-right: 3px solid #ef4444; }\n';

// ---------------------------------------------------------------------------
// A size the detector could not read is coverage, not an anti-pattern
// ---------------------------------------------------------------------------

test('a size the detector could not price is not reported as a finding', () => {
  const run = detect({ 'sizes.css': 'h1 { font-size: 4vw }\n' });
  assert.deepEqual(run.findings, []);
  assert.equal(run.status, 0);
});

test('the coverage note names the file and the declaration it could not price', () => {
  const run = detect({ 'sizes.css': 'h1 { font-size: 4vw }\n' });
  assert.match(run.stderr, /sizes\.css/);
  assert.match(run.stderr, /font-size: 4vw/);
});

test('the coverage note says what a verdict drawn from the rest is worth', () => {
  const run = detect({ 'sizes.css': 'h1 { font-size: 4vw }\n' });
  const rule = getAntipattern('unresolvable-font-size');
  assert.ok(rule, 'positive control: the rule must be in the registry');
  assert.ok(
    run.stderr.includes(/** @type {{ description: string }} */ (rule).description),
    'the coverage note must carry what the finding carried'
  );
});

test('the coverage note names the engine that could not read the size', () => {
  const run = detect({ 'sizes.css': 'h1 { font-size: 4vw }\n' });
  assert.match(run.stderr, new RegExp(`engine: ${ENGINE_REGEX}`));
});

test('coverage alone does not stop the run from reading clean', () => {
  const run = detect({ 'sizes.css': 'h1 { font-size: 4vw }\n' });
  assert.equal(run.stdout.trim(), '[]');
});

test('an anti-pattern beside coverage is still reported', () => {
  const run = detect({ 'sizes.css': `${CONTROL_CSS}h1 { font-size: 4vw }\n` });
  assert.deepEqual(
    run.findings.map((f) => f.antipattern),
    ['side-tab']
  );
  assert.equal(run.status, 2);
});

// ---------------------------------------------------------------------------
// One fact, printed once
// ---------------------------------------------------------------------------

// `gradient-text` has two emitters in the static-HTML engine reaching different
// things — one reads the cascade, the other the source text — and neither
// answers everything the other does, so both stay. On a page both see, they say
// the same thing twice.
const GRADIENT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title>
<style>.g { background-image: linear-gradient(#ff0000, #0000ff); background-clip: text; -webkit-background-clip: text; color: transparent }</style>
</head><body><h1 class="g">Headline</h1></body></html>
`;

test('two emitters of one verdict on one file are reported once', () => {
  const run = detect({ 'page.html': GRADIENT_PAGE });
  assert.deepEqual(
    run.findings.filter((f) => f.antipattern === 'gradient-text').map((f) => f.snippet),
    ['background-clip: text + gradient']
  );
});

test('a row is dropped only by a row identical to it', () => {
  /** @param {Partial<import('../findings.mjs').Finding>} over */
  const row = (over) => ({
    antipattern: 'gradient-text',
    name: 'Gradient text',
    description: 'd',
    severity: 'warning',
    file: 'a.html',
    line: 0,
    snippet: 'background-clip: text + gradient',
    engine: ENGINE_STATIC_HTML,
    ...over,
  });
  assert.equal(dedupeFindings([row({}), row({})]).length, 1);
  assert.equal(dedupeFindings([row({}), row({ line: 4 })]).length, 2);
  assert.equal(dedupeFindings([row({}), row({ snippet: 'other' })]).length, 2);
  assert.equal(dedupeFindings([row({}), row({ file: 'b.html' })]).length, 2);
});

// The engine is part of what makes a row that row, because two engines phrase
// one verdict differently — `broken-image` answers `<img src="">` in one and
// `<img src=""` in the other for the same markup. Keeping the engine in the key
// is what stops a collapse from deciding which of two engines spoke.
test('two engines reporting one verdict are never collapsed into one row', () => {
  /** @param {string} engine */
  const row = (engine) => ({
    antipattern: 'gradient-text',
    name: 'Gradient text',
    description: 'd',
    severity: 'warning',
    file: 'a.html',
    line: 0,
    snippet: 'background-clip: text + gradient',
    engine,
  });
  assert.equal(dedupeFindings([row(ENGINE_STATIC_HTML), row(ENGINE_REGEX)]).length, 2);
});

// And what makes that safe rather than merely careful: a scan reads each file
// with exactly one engine, so a file never carries two phrasings of one verdict
// for a reader to choose between.
test('a scan reads each file with exactly one engine', () => {
  const run = detect({ 'page.html': GRADIENT_PAGE, 'sheet.css': CONTROL_CSS });
  /** @type {Map<string, Set<string>>} */
  const byFile = new Map();
  for (const f of run.findings) {
    const seen = byFile.get(f.file) ?? new Set();
    seen.add(/** @type {string} */ (f.engine));
    byFile.set(f.file, seen);
  }
  assert.equal(byFile.size, 2, 'positive control: both files must have been read');
  assert.deepEqual(
    [...byFile.values()].map((engines) => [...engines]).sort(),
    [[ENGINE_REGEX], [ENGINE_STATIC_HTML]]
  );
});

// ---------------------------------------------------------------------------
// How far the walk read
// ---------------------------------------------------------------------------

// A generated file is left out of a directory walk, so a directory holding
// nothing else scans nothing — and an empty result is spelled exactly like a
// clean one. The skip has to be said out loud, or the reader cannot tell a
// verdict from a walk that never happened.

/** A stylesheet the walk leaves out, carrying a finding it would report if it
 *  did not. */
const GENERATED_CSS = `/* @generated by the bundler */\n${CONTROL_CSS}`;

test('a directory whose files are all generated says so instead of nothing', () => {
  const run = detect({ 'bundle.css': GENERATED_CSS });
  assert.deepEqual(run.findings, []);
  assert.match(run.stderr, /1 file .* generated and (?:was|were) not scanned/);
});

test('the note names the target the files were left out of', () => {
  const run = detectTarget(
    { 'src-out/bundle.css': GENERATED_CSS, 'src-out/vendor.css': GENERATED_CSS },
    'src-out'
  );
  assert.match(run.stderr, /2 files under src-out/);
});

test('a directory holding nothing generated says nothing about generated files', () => {
  const run = detect({ 'sheet.css': CONTROL_CSS });
  assert.equal(
    run.findings.map((f) => f.antipattern).includes('side-tab'),
    true,
    'positive control: the clean directory must have been scanned'
  );
  assert.doesNotMatch(run.stderr, /generated/);
});

test('a generated file named on the command line is scanned, and no note claims otherwise', () => {
  const run = detectTarget({ 'bundle.css': GENERATED_CSS }, 'bundle.css');
  assert.deepEqual(
    run.findings.map((f) => f.antipattern),
    ['side-tab']
  );
  assert.doesNotMatch(run.stderr, /generated/);
});
