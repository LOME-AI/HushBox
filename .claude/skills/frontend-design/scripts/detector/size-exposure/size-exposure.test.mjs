/**
 * Which registered rules a font size written into the default-stylesheet map
 * can reach, checked rather than described.
 *
 * `engines/static-html/css-cascade.mjs` states the size a browser's own
 * stylesheet gives an element the page does not size. Which rules that value
 * can then change is a question a paragraph beside the map cannot answer
 * durably: a list written by hand is a second copy of something the tree
 * already determines, and a second copy that has to agree drifts.
 *
 * So the answer is computed twice, from opposite directions, and the two are
 * made to agree here:
 *
 *   `derivation.mjs`  parses every module the static-HTML engine can load and
 *                     computes, from the call graph, the registered ids a
 *                     modelled size can reach.
 *   `sweep.mjs`       drives a page population through the engine four times —
 *                     once as the tree stands and once per mutation of the map
 *                     — and reports which verdicts actually moved.
 *
 * A rule the derivation admits and the population does not answer stops the
 * sweep, and so does a verdict that moves where the derivation admits none.
 * Four rules once hid in the gap between "the population reached thirteen ids"
 * and "the population covered the ids it owed", which is the failure these
 * cases exist to make loud.
 *
 * The repository runs these files automatically; which files it runs is decided
 * by node's own test-file naming convention over the skill tree. Run them on
 * their own with `node --test` and an explicit file list; a bare directory
 * argument is an invocation error, not a red suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { admittedIds } from './derivation.mjs';
import { DISPOSITIONS } from './pages.mjs';
import { collectTakes, coverageFailuresFor, grade } from './sweep.mjs';

/** The takes are four child processes over the whole population; one set serves every case. */
let takes = null;
async function population() {
  takes ??= await collectTakes();
  return takes;
}

/**
 * @param {Record<string, { disposition: string, why: string }>} map
 * @param {string} key
 * @returns {Record<string, { disposition: string, why: string }>}
 */
function without(map, key) {
  const copy = { ...map };
  delete copy[key];
  return copy;
}

test('the admitted set is read out of the engine own source', () => {
  // Instrument control. A derivation that stopped finding emissions would admit
  // nothing and every coverage case below would pass vacuously.
  const admitted = admittedIds();
  assert.ok(admitted.size >= 20, `expected the engine sources to admit many ids, read ${admitted.size}`);
  assert.ok(admitted.has('low-contrast'), 'a rule that reads a size at its own emission site must be admitted');
  assert.ok(admitted.has('repeated-section-kickers'), 'a rule handed a size by a caller must be admitted');
  assert.ok(!admitted.has('em-dash-overuse'), 'a rule no font size reaches must not be admitted');
});

test('every id the derivation admits is answered by the population', async () => {
  const graded = await population();
  const result = grade(graded);
  assert.deepEqual(coverageFailuresFor(result.coverageInput), []);
});

test('no arm moves the subject it does not name', async () => {
  const graded = await population();
  const result = grade(graded);
  const control = [...result.movedBy.entries()].filter(([, v]) => v.tags.has('span')).map(([rule]) => rule);
  assert.deepEqual(control, []);
});

test('the sweep refuses a population that leaves an admitted id unanswered', async () => {
  const graded = await population();
  assert.throws(
    () => grade(graded, { dispositions: without(DISPOSITIONS, 'oversized-h1') }),
    /oversized-h1: the derivation says a modelled size can reach this rule and the population does not answer it/
  );
});

test('the coverage guard refuses a declared mover that did not move', async () => {
  const graded = await population();
  const input = grade(graded).coverageInput;
  const moved = new Set(input.moved);
  moved.delete('cramped-padding');
  const failures = coverageFailuresFor({ ...input, moved });
  assert.match(failures.join('\n'), /cramped-padding: declared to move and did not/);
});

test('the coverage guard refuses a declared decliner that moved', async () => {
  const graded = await population();
  const input = grade(graded).coverageInput;
  const failures = coverageFailuresFor({ ...input, moved: new Set([...input.moved, 'justified-text']) });
  assert.match(failures.join('\n'), /justified-text: declared to decline and it moved/);
});

test('the coverage guard refuses a mover the derivation does not admit', async () => {
  const graded = await population();
  const input = grade(graded).coverageInput;
  const failures = coverageFailuresFor({ ...input, moved: new Set([...input.moved, 'em-dash-overuse']) });
  assert.match(failures.join('\n'), /em-dash-overuse: MOVED, and the derivation says a size cannot reach it/);
});
