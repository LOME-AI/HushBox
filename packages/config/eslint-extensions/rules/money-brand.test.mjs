// The bounds of the brand walk `money-brand.mjs` performs, observed through the
// derivation that consumes it (`money-domain.mjs`).
//
// Every shape below type-checks clean. Some are found and some are missed, and
// the missed ones are the file's stated bounds — pinned here so a later edit
// cannot narrow the walk in silence, and so no header can claim a reach the
// walk does not have.
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { withScratchDirectory } from '../../../../scripts/lib/scratch-directory.ts';
import { moneyVocabularyDomain, REPO_ROOT, unclassifiedExports } from './money-domain.mjs';

/**
 * Stages one module outside the repository, hands `body` its path, and removes
 * the tree however `body` ends.
 *
 * A fixture tree beside this file is a directory every repo-wide scanner
 * enumerates, so one that exists between a test's setup and its teardown is
 * read as repository source or crashes the scan listing it. Location is what
 * closes that, not timing. Each derivation below reads the staged module while
 * it builds its program and returns plain names, so the tree is only needed for
 * the length of that one call.
 *
 * The install link is load-bearing, not tidiness: every shape below is judged by
 * the RESOLVED symbol of a parameter whose type comes from `@playwright/test`,
 * and the checker finds that package by walking up from the module it is
 * reading. A staged module with no install above it resolves the import to
 * nothing, and the four assertions about a request context then pass or fail on
 * an unresolved type rather than on the walk they name. What makes the link safe
 * — that removing the scratch tree unlinks it rather than descending into the
 * install — is asserted by `scripts/lib/scratch-directory.test.ts`.
 * @param {string} prefix
 * @param {string} name
 * @param {string} source
 * @param {(modulePath: string) => void} body
 * @returns {Promise<void>}
 */
function withFixtureModule(prefix, name, source, body) {
  return withScratchDirectory(prefix, (fixtureDir) => {
    symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(fixtureDir, 'node_modules'),
      'junction'
    );
    const modulePath = path.join(fixtureDir, name);
    writeFileSync(modulePath, source);
    body(modulePath);
    return Promise.resolve();
  });
}

describe('the domain derivation sees what a text match cannot', () => {
  // Each shape below type-checks clean and was invisible to the previous
  // derivation, which matched parameter TEXT against a list of brand names.
  const FIXTURE = `
import type { APIRequestContext } from '@playwright/test';
import type { APIRequestContext as RenamedContext } from '@playwright/test';
declare const freshBrand: unique symbol;
type Fresh = string & { readonly [freshBrand]: 'fresh' };
type Aliased = Fresh;
type Context = APIRequestContext;

export const arrowConst = (value: Fresh): number => value.length;
export function aliasedParameter(value: Aliased): number { return value.length; }
export function freshlyBranded(request: Context): Promise<Fresh> { return request.get('/').then(() => '' as Fresh); }
export function plainString(value: string): number { return value.length; }
export function readsThroughRenamedImport(request: RenamedContext): Promise<string> { return request.get('/').then(() => ''); }
function declaredUnderAnotherName(value: Fresh): number { return value.length; }
export { declaredUnderAnotherName as renamedAtExport };
`;

  /** @type {ReturnType<typeof moneyVocabularyDomain>} */
  let domain;

  beforeAll(() =>
    withFixtureModule('hushbox-money-domain-', 'shapes.ts', FIXTURE, (shapes) => {
      domain = moneyVocabularyDomain([shapes]);
    })
  );

  it('finds an arrow-function export, an aliased parameter and a brand no list names', () => {
    expect(domain).toEqual([
      'aliasedParameter',
      'arrowConst',
      'freshlyBranded',
      'readsThroughRenamedImport',
      'renamedAtExport',
    ]);
  });

  it('resolves a renamed import in parameter position, which only the context arm can admit', () => {
    // No brand anywhere in this signature, so the parameter's RESOLVED symbol
    // is the only thing that can put it in the domain — which is what makes
    // this the route the claim names, rather than a renamed re-export.
    expect(domain).toContain('readsThroughRenamedImport');
    expect(domain).not.toContain('plainString');
  });
});

describe('a read the derivation misses', () => {
  // The four shapes the context arm does not match. Each is a plausible read —
  // a context made readonly, an optional one, a batch of them, one held on an
  // options object — and each lands outside the derived domain WHEN nothing
  // else in its signature carries a brand: a read returning a branded payload
  // is admitted by the brand arm whatever shape its context is in, which is why
  // every read shipped today is in the domain. Exhaustion is what catches the
  // rest: unclassified, so named, rather than silently unprotected.
  const FIXTURE = `
import type { APIRequestContext } from '@playwright/test';
declare const observedBrand: unique symbol;
type Observed = bigint & { readonly [observedBrand]: 'observed' };

export function readMadeReadonly(request: Readonly<APIRequestContext>): Promise<unknown> { return request.get('/'); }
export function readPossiblyAbsent(request: APIRequestContext | undefined): number { return request === undefined ? 0 : 1; }
export function readOverSeveral(requests: APIRequestContext[]): number { return requests.length; }
export function readFromOptions(options: { request: APIRequestContext }): Promise<unknown> { return options.request.get('/'); }
export function readSettled(request: APIRequestContext): Promise<Observed> { return request.get('/').then(() => 0n as Observed); }
`;

  /** @type {ReturnType<typeof unclassifiedExports>} */
  let unclassified;

  beforeAll(() =>
    withFixtureModule('hushbox-money-unclassified-', 'reads.ts', FIXTURE, (reads) => {
      // One program for the whole describe: building it is the expensive half of
      // this suite, and the package's pole rule fails a file that hogs the run.
      unclassified = unclassifiedExports([reads], []);
    })
  );

  it('is named by the gate in every context shape the derivation does not match', () => {
    expect(unclassified).toEqual([
      'readFromOptions',
      'readMadeReadonly',
      'readOverSeveral',
      'readPossiblyAbsent',
    ]);
  });

  it('is not named when the derivation does admit it', () => {
    // `readSettled` takes the context in its own right, so it is derived rather
    // than classified — which is what makes the list above a gate and not a
    // second enumeration of everything.
    expect(unclassified).not.toContain('readSettled');
  });
});

describe('the bounds of the walk the derivation rests on', () => {
  // The derivation is only as wide as `brandDetection`'s walk and the context
  // arm beside it, and the two headers state those bounds rather than claiming
  // any brand is found. Each shape below type-checks clean and is missed.
  const FIXTURE = `
import type { APIRequestContext } from '@playwright/test';
declare const freshBrand: unique symbol;
type Fresh = string & { readonly [freshBrand]: 'fresh' };

export function brandedParameter(value: Fresh): number { return value.length; }
export function contextParameter(request: APIRequestContext): Promise<unknown> { return request.get('/'); }
export function fourLevelsIn(value: { a: { b: { c: { d: Fresh } } } }): number { return value.a.b.c.d.length; }
export function fiveLevelsIn(value: { a: { b: { c: { d: { e: Fresh } } } } }): number { return value.a.b.c.d.e.length; }
export function behindAStringIndex(value: { [key: string]: Fresh }): number { return Object.keys(value).length; }
export function behindACallback(consume: (value: Fresh) => void): void { consume('' as Fresh); }
export function contextMadeReadonly(request: Readonly<APIRequestContext>): Promise<unknown> { return request.get('/'); }
export function contextPossiblyAbsent(request: APIRequestContext | undefined): number { return request === undefined ? 0 : 1; }
export function contextInAnArray(requests: APIRequestContext[]): number { return requests.length; }
export function contextOnAProperty(box: { request: APIRequestContext }): Promise<unknown> { return box.request.get('/'); }
`;

  /** @type {Set<string>} */
  let found;

  beforeAll(() =>
    withFixtureModule('hushbox-money-walk-', 'bounds.ts', FIXTURE, (bounds) => {
      found = new Set(moneyVocabularyDomain([bounds]));
    })
  );

  it('reaches a brand four levels into a parameter type, and no further', () => {
    // The depth is a constant, and a constant nothing asserts can be lowered in
    // a later edit with every gate staying green — the silent narrowing this
    // whole vocabulary exists to make impossible.
    expect(found.has('fourLevelsIn')).toBe(true);
    expect(found.has('fiveLevelsIn')).toBe(false);
  });

  it('does not reach a brand a string index signature holds', () => {
    expect(found.has('brandedParameter')).toBe(true);
    expect(found.has('behindAStringIndex')).toBe(false);
  });

  it('does not reach a brand only a callback parameter takes', () => {
    expect(found.has('brandedParameter')).toBe(true);
    expect(found.has('behindACallback')).toBe(false);
  });

  it('matches a request context in its own right, not one wrapped, unioned, listed or held', () => {
    expect(found.has('contextParameter')).toBe(true);
    expect(
      [
        'contextMadeReadonly',
        'contextPossiblyAbsent',
        'contextInAnArray',
        'contextOnAProperty',
      ].filter((name) => found.has(name))
    ).toEqual([]);
  });
});
