/**
 * # The one reading of a rate-limit spend site, shared by both whole-app walks
 *
 * `whole-app/app-flow-counter-citations.test.ts` walks from every line that
 * spends a counter to the route citation that declares it;
 * `whole-app/app-network-lockout-resolver.test.ts` walks from the same lines to
 * the resolver that answered the caller's network. Two questions, one subject:
 * the calls to the primitives `consume` and `consumeLayers`, imported from
 * `lib/rate-limit`, in a non-test module outside that directory.
 *
 * The subject is read once, here, because two walks each keeping their own
 * reading of a call site drift apart — `packages/config/arch/README.md` records
 * that happening to two arch rules, which "diverged into a strict subset"
 * before one shared module fixed it. The failure mode is worse for a gate than
 * for a rule: a rule that reads too little reports the wrong thing, a gate that
 * reads too little reports nothing at all.
 *
 * ## What stays with each walk
 *
 * File enumeration and the destructuring of a `consumeLayers` layer list. Those
 * differ in substance rather than by accident: the resolver walk needs
 * `lib/rate-limit` parsed into its call graph and excludes it later, skips
 * `test-support` and setup modules, and reads each layer's identity as well as
 * its definition. Collapsing either would cost one walk precision it depends on.
 *
 * ## Refusing rather than skipping
 *
 * An import shape neither walk can follow throws here. A spend the walks cannot
 * see is a hole both would report green over, and a check that passes over what
 * it cannot see reads exactly like one that saw nothing wrong.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * This Worker's source root. Derived from this module's own location, so both
 * walks agree on it however either of them is spelled or moved.
 */
export const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The directory whose own spends are the primitive's delegation, not a flow's. */
export const PRIMITIVE_DIR = path.join('lib', 'rate-limit');

/** The module path fragment every import of the spend primitives carries. */
export const PRIMITIVE_SPECIFIER = 'lib/rate-limit/';

/** The exported functions that spend a counter. */
export const SPEND_FUNCTIONS = ['consume', 'consumeLayers'] as const;

export type SpendFunction = (typeof SPEND_FUNCTIONS)[number];

export function isSpendFunction(name: string): name is SpendFunction {
  return (SPEND_FUNCTIONS as readonly string[]).includes(name);
}

/** A repo-relative path, in one spelling on every platform. */
export function repoRelative(file: string): string {
  return `apps/api/src/${path.relative(API_SRC, file).split(path.sep).join('/')}`;
}

/** The named imports one statement carries, once type-only shapes are dropped. */
export function namedImportElements(statement: ts.Statement): readonly ts.ImportSpecifier[] {
  if (!ts.isImportDeclaration(statement)) return [];
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return [];
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.filter((element) => !element.isTypeOnly);
}

/** The module one import declaration names, refusing a specifier this walk cannot read. */
export function importSpecifierText(statement: ts.ImportDeclaration, where: string): string {
  const { moduleSpecifier } = statement;
  if (!ts.isStringLiteral(moduleSpecifier)) {
    throw new Error(`${where}: an import specifier this walk cannot read.`);
  }
  return moduleSpecifier.text;
}

/**
 * Refuses the two import shapes that would hide a spend: the primitives reached
 * through a namespace, and either primitive's name imported from anywhere but
 * the primitive itself — a re-export chain whose call sites the walks would
 * never see, or a different function that has taken a reserved name.
 *
 * A type-only declaration is neither. It is erased before anything runs, so no
 * call can reach a primitive through it.
 */
function refuseHiddenSpends(
  statement: ts.ImportDeclaration,
  specifier: string,
  where: string
): void {
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return;
  const fromPrimitive = specifier.includes(PRIMITIVE_SPECIFIER);
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings) && fromPrimitive) {
    throw new Error(
      `${where}: namespace import of the rate-limit primitives — these walks read named ` +
        'imports, so a spend reached through the namespace would go unseen.'
    );
  }
  if (fromPrimitive) return;
  for (const element of namedImportElements(statement)) {
    const imported = (element.propertyName ?? element.name).text;
    if (isSpendFunction(imported)) {
      throw new Error(
        `${where}: imports '${imported}' from '${specifier}' — the rate-limit primitive is the ` +
          'only thing this Worker may spend a counter through, and these walks read only calls ' +
          "they can attribute to lib/rate-limit's own export."
      );
    }
  }
}

/**
 * The local names one module binds to the spend primitives, keyed by which
 * primitive each is — an alias is followed, so `import { consume as spend }` is
 * read.
 */
export function spendBindings(source: ts.SourceFile): ReadonlyMap<string, SpendFunction> {
  const bound = new Map<string, SpendFunction>();
  const where = repoRelative(source.fileName);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = importSpecifierText(statement, where);
    refuseHiddenSpends(statement, specifier, where);
    if (!specifier.includes(PRIMITIVE_SPECIFIER)) continue;
    for (const element of namedImportElements(statement)) {
      const imported = (element.propertyName ?? element.name).text;
      if (isSpendFunction(imported)) bound.set(element.name.text, imported);
    }
  }
  return bound;
}
