/**
 * Every rule the registry declares is a rule some engine can emit.
 *
 * The registry is what the tool tells a reader it checks: the CLI names its
 * rules from it, `finding()` takes a verdict's name and description from it, and
 * a stop condition counts what comes out of it. A row in it that no code emits
 * is a check the tool promises and never performs, and nothing in the tree said
 * so — `text-overflow` sat there against no emitter at all, because it needs a
 * layout this engine does not do.
 *
 * The population is DERIVED rather than listed, which is the point of the case:
 * a list would have to be edited alongside the registry and would then agree
 * with it by construction. The emitted set is read off the engine sources as the
 * literal ids they hand to a verdict, so adding a registry row without an
 * emitter reds here on the next run.
 *
 * ONE DIRECTION ONLY. This case asserts nothing about an emitted id the registry
 * does not carry: `finding()` degrades such a verdict to a minimal row on
 * purpose, so that direction is a designed behaviour rather than a promise
 * broken.
 *
 * WHAT IT CANNOT SEE. An id whose emit site exists but sits on a branch no
 * engine can reach reads as emitted here — which is exactly what
 * `animate-bounce` was, its call site handing the check an empty class list.
 * That half is pinned where the rule's own cases are, by driving the rule.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Run them on
 * their own with `node --test` and an explicit file list; a bare directory
 * argument is an invocation error, not a red suite.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ANTIPATTERNS } from './registry/antipatterns.mjs';

const DETECTOR_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The registry itself is not an emitter; every other module in the tree is. */
const REGISTRY_FILE = path.join(DETECTOR_ROOT, 'registry', 'antipatterns.mjs');

/**
 * The three forms a verdict's id is written in: the `id` of a rule finding, the
 * `antipattern` of an already-built finding, and the first argument to a
 * finding constructor. The last is matched on the callee's suffix rather than on
 * one name, because the design-system rules build theirs through a second
 * constructor and a pattern naming `finding` alone read all three of them as
 * promised-but-unemitted.
 */
const EMITTED_ID = /\bid:\s*'([a-z0-9-]+)'|\bantipattern:\s*'([a-z0-9-]+)'|\b\w*[Ff]inding\(\s*'([a-z0-9-]+)'/g;

/** @param {string} dir @returns {string[]} */
function engineSources(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...engineSources(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

/** Every id the engine sources hand to a verdict. */
function emittedIds() {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const file of engineSources(DETECTOR_ROOT)) {
    if (file === REGISTRY_FILE) continue;
    const source = fs.readFileSync(file, 'utf-8');
    for (const match of source.matchAll(EMITTED_ID)) {
      const id = match[1] ?? match[2] ?? match[3];
      if (id) ids.add(id);
    }
  }
  return ids;
}

test('the derivation reads ids out of more than one engine source', () => {
  // Instrument control: a pattern that stopped matching would leave the case
  // below asserting a registry against an empty set and reporting every rule as
  // unemitted, which is loud — but one that matched too little would go quiet.
  const ids = emittedIds();
  assert.ok(ids.size >= 20, `expected the engine sources to emit many ids, read ${ids.size}`);
  assert.ok(ids.has('low-contrast'), 'a rule the element checks emit must be read');
  assert.ok(ids.has('em-dash-overuse'), 'a rule the text analyzers emit must be read');
  assert.ok(ids.has('design-system-font'), 'a rule built through a second finding constructor must be read');
});

test('every registered rule has an emitter in the engine sources', () => {
  const ids = emittedIds();
  const promised = ANTIPATTERNS.map((rule) => rule.id).filter((id) => !ids.has(id));
  assert.deepEqual(promised, []);
});
