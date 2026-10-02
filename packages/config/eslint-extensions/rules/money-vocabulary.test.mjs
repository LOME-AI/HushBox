// The gate on the vocabulary list itself, over the two real modules.
//
// The rule can only protect a name it knows, and a missing name is invisible to
// every behavioural test the rule has — each of those necessarily calls a name
// that IS listed. So the list is derived rather than curated, and what the
// derivation does not admit is classified by hand: the two together must
// exhaust the modules' callable exports.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { MONEY_NON_VOCABULARY, MONEY_VOCABULARY } from '../no-forged-money-input.config.mjs';
import {
  REPO_ROOT,
  VOCABULARY_MODULES,
  moneyModuleExports,
  unclassifiedExports,
} from './money-domain.mjs';

const CLASSIFIED_NON_VOCABULARY = Object.values(MONEY_NON_VOCABULARY).flat();
const MODULE_PATHS = VOCABULARY_MODULES.map((file) => path.join(REPO_ROOT, file));

/** @type {ReturnType<typeof moneyModuleExports> | undefined} */
let exports_;
function vocabularyExports() {
  exports_ ??= moneyModuleExports(MODULE_PATHS);
  return exports_;
}

function vocabularyDomain() {
  return vocabularyExports().domain;
}

describe('the vocabulary list is complete', () => {
  // The rule can only protect a name it knows. A missing name is invisible to
  // every behavioural test above, so completeness is checked against the source
  // rather than trusted — this is the gate the list itself rests on.
  it('names every exported function that takes, produces, or reads for a branded value', () => {
    const missing = vocabularyDomain().filter((name) => !MONEY_VOCABULARY.includes(name));
    expect(vocabularyDomain().length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('names nothing outside that domain, so a rename cannot leave a dead entry', () => {
    const domainNames = new Set(vocabularyDomain());
    expect(MONEY_VOCABULARY.filter((name) => !domainNames.has(name))).toEqual([]);
  });

  // The derivation has bounds — a brand behind a string index signature, a
  // context resolved to anything but `APIRequestContext` — so completeness
  // cannot rest on it. Exhaustion can: every callable export is either derived
  // into the domain or classified out of it by hand, and a function added in a
  // shape the derivation misses lands in neither and fails here by name.
  it('classifies every callable export of both modules', () => {
    const { callable } = vocabularyExports();
    expect(callable.length).toBeGreaterThan(MONEY_VOCABULARY.length);
    expect(unclassifiedExports(MODULE_PATHS, CLASSIFIED_NON_VOCABULARY)).toEqual([]);
  });

  it('refuses a non-vocabulary name the derivation itself admits', () => {
    const domainNames = new Set(vocabularyDomain());
    expect(CLASSIFIED_NON_VOCABULARY.filter((name) => domainNames.has(name))).toEqual([]);
  });

  it('refuses a non-vocabulary name neither module exports', () => {
    const callableNames = new Set(vocabularyExports().callable);
    expect(CLASSIFIED_NON_VOCABULARY.filter((name) => !callableNames.has(name))).toEqual([]);
  });
});
