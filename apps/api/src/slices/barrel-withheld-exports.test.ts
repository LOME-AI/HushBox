/**
 * Slice barrels whose prose says a named symbol is withheld from them, pinned
 * to their own export statements.
 *
 * The boundaries config governs which MODULES a file may import, and states its
 * own blind spot: "What the mechanism cannot see is a symbol: an element
 * matches by path, so a module re-exported from a slice barrel is the barrel as
 * far as these rules go" (`packages/config/eslint-extensions/boundaries.config.mjs`).
 * A barrel that republishes what its comment says it withholds therefore lints,
 * typechecks and tests green, and the sentence stands on review alone.
 *
 * The check reads the barrel TEXT rather than runtime bindings, following
 * `slices/models/barrel.test.ts`: a type has no runtime presence to enumerate,
 * and an `export type` is exactly what some of these sentences withhold.
 *
 * Each block asserts that the names it names are absent from one barrel's
 * export statements, and asserts one name that barrel does publish so an
 * absence is an absence rather than an empty read. Nothing here checks the
 * REASON a barrel gives for withholding a name, and nothing here is a claim
 * about a barrel it does not name.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SLICES = path.dirname(fileURLToPath(import.meta.url));

function sourceOf(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
}

/**
 * Every name one barrel file publishes, whether value or type. An export this
 * cannot enumerate — `export *`, `export * as ns`, a locally declared `export`
 * — throws instead of being skipped, because a skipped export leaves the set
 * short and a short set reads exactly like an honoured absence.
 */
function publishedNames(file: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceOf(file).statements) {
    if (ts.isImportDeclaration(statement)) continue;
    const clause = ts.isExportDeclaration(statement) ? statement.exportClause : undefined;
    if (clause === undefined || !ts.isNamedExports(clause)) {
      throw new Error(`${file}: export this reader cannot enumerate: ${statement.getText()}`);
    }
    for (const element of clause.elements) names.add(element.name.text);
  }
  return names;
}

/** True when a statement carries the `export` keyword. */
function isExported(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/** Every name a module declares with the `export` keyword, whether value or type. */
function declaredNames(file: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceOf(file).statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.add(declaration.name.getText());
      }
      continue;
    }
    const named = statement as { readonly name?: ts.Identifier };
    if (named.name !== undefined) names.add(named.name.text);
  }
  return names;
}

/** The named-import elements one statement brings in from one module specifier. */
function namedImportsOf(statement: ts.Statement, specifier: string): readonly ts.ImportSpecifier[] {
  if (!ts.isImportDeclaration(statement)) return [];
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
  if (statement.moduleSpecifier.text !== specifier) return [];
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
  return bindings.elements;
}

/** The names a module imports from one module specifier. */
function importedFrom(file: string, specifier: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceOf(file).statements) {
    for (const element of namedImportsOf(statement, specifier)) names.add(element.name.text);
  }
  return names;
}

/**
 * One alphabetical, duplicate-free reading of a derived set — two modules that
 * declare the same name would otherwise give two identically-titled cases.
 */
function alphabetical(names: Iterable<string>): readonly string[] {
  return [...new Set(names)].toSorted((left, right) => left.localeCompare(right));
}

describe('the chat domain barrel', () => {
  const published = publishedNames(path.join(SLICES, 'chat', 'domain', 'index.ts'));

  // The withheld set is derived from the modules the barrel's comment names as
  // composing the models barrel for themselves, so a producer added to any of
  // those gates is pinned the day it arrives rather than the day someone
  // remembers this list.
  const chatDomain = path.join(SLICES, 'chat', 'domain');
  // Kept per gate rather than unioned here: a gate that stopped composing the
  // models barrel — or whose specifier moved — would shrink the union while
  // leaving it non-empty from another gate, so the pin would quietly cover
  // some gates and read as covering all of them.
  const gates = ['turn/pricing.ts', 'turn/tier-gate.ts', 'trial/gate.ts'].map((file) => ({
    file,
    composes: importedFrom(path.join(chatDomain, file), '../../../models/index.js'),
  }));
  const composed = new Set(gates.flatMap(({ composes }) => [...composes]));
  // The per-message cap is the one name a gate composes AND the barrel still
  // publishes, because the trial ROUTE spends its turn budget against the same
  // ceiling. Publishing it re-derives no rule: the cost producer the gate's
  // comparison needs is withheld, so the cap on its own answers nothing.
  const composedProducers = alphabetical(
    [...composed].filter((name) => name !== 'TRIAL_MESSAGE_COST_CAP_NANO_USD')
  );

  it('publishes the gated turn seam, so absence below is absence rather than an empty read', () => {
    expect(published.has('gatedTurnContext')).toBe(true);
  });

  it.each(gates)('derives a non-empty producer set from $file', ({ composes }) => {
    expect(composes.size).toBeGreaterThan(0);
  });

  it.each(composedProducers)('does not republish the composed producer %s', (name) => {
    expect(published.has(name)).toBe(false);
  });

  it('does not republish the realtime room-name helper', () => {
    expect(published.has('trialRoomName')).toBe(false);
  });
});

describe('the conversations slice barrel', () => {
  const published = publishedNames(path.join(SLICES, 'conversations', 'index.ts'));

  it('publishes the slice API, so absence below is absence rather than an empty read', () => {
    expect(published.has('resolveConversationCaller')).toBe(true);
  });

  it('does not republish the room bindings the `public/` door serves', () => {
    expect(published.has('createRoomBindings')).toBe(false);
  });
});

describe('the notifications slice barrel', () => {
  const published = publishedNames(path.join(SLICES, 'notifications', 'index.ts'));

  it('publishes the slice API, so absence below is absence rather than an empty read', () => {
    expect(published.has('createPushSenderFromEnv')).toBe(true);
  });

  it.each(['createFcmPushSender', 'createWebPushSender'])(
    'does not republish the raw transport %s',
    (name) => {
      expect(published.has(name)).toBe(false);
    }
  );
});

describe('the admin domain barrel', () => {
  const published = publishedNames(path.join(SLICES, 'admin', 'domain', 'index.ts'));

  // Derived from the two modules the barrel's comment marks as deliberately not
  // exported, so a name added to either is withheld without an edit here.
  const adminDomain = path.join(SLICES, 'admin', 'domain');
  const testOnly = alphabetical([
    ...declaredNames(path.join(adminDomain, 'describe-admin-op.ts')),
    ...declaredNames(path.join(adminDomain, 'fixture-ops.ts')),
  ]);

  it('publishes the bespoke read surface, so absence below is absence rather than an empty read', () => {
    expect(published.has('loadCustomer360')).toBe(true);
  });

  it('derives a non-empty set from the two test-only modules', () => {
    expect(testOnly.length).toBeGreaterThan(0);
  });

  it.each(testOnly)('does not export the test-only %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});
