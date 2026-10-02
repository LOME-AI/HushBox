import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

// TanStack Router's auto code-splitting only lazy-chunks a route-node value
// (component / loader / pendingComponent / errorComponent / notFoundComponent)
// when its identifier is NOT exported from the route file: the plugin hard-codes
// `shouldSplit = !isExported`. A route file that exports anything besides `Route`
// (commonly its page component, so a colocated test can import it) therefore
// ships that value eagerly in the boot path instead of in a per-route chunk.
// This guardrail keeps every route file exporting ONLY `Route` so the splitter
// can do its job. Relocate any other value into a `-`-prefixed sibling module
// (excluded from the route tree) and import it back into the route config.
//
// `export type` / `export interface` are erased at compile time and never reach
// the bundle, so type-only exports are allowed.
//
// `__root.tsx` is exempt: the root route is always eager (it is never lazily
// chunked), so its exports are irrelevant to splitting. It already exports only
// `Route`, but the exemption documents the intent rather than relying on that.

const ROUTES_DIR = import.meta.dirname;
const ROOT_ROUTE_FILE = '__root.tsx';

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.tsx?$/.test(entry))
    .filter((entry) => !/\.test\.tsx?$/.test(entry))
    .filter((entry) => {
      const base = entry.split(/[\\/]/).pop() ?? entry;
      // `-`-prefixed files are excluded from the TanStack route tree and exist
      // to hold relocated, exported route-node values — exempt by design.
      return !base.startsWith('-');
    })
    .filter((entry) => entry !== ROOT_ROUTE_FILE);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function exportedVariableNames(node: ts.VariableStatement): string[] {
  return node.declarationList.declarations
    .map((decl) => decl.name)
    .filter((name): name is ts.Identifier => ts.isIdentifier(name))
    .map((name) => name.text);
}

// `export { Foo, Bar }` / `export { type Baz, Qux }` re-export statements.
function exportedSpecifierNames(node: ts.ExportDeclaration): string[] {
  if (node.isTypeOnly || !node.exportClause || !ts.isNamedExports(node.exportClause)) return [];
  return node.exportClause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => element.name.text);
}

// Names a top-level statement contributes to the module's VALUE exports.
// Type-only constructs (`export type`/`export interface`, `export type { ... }`,
// type-only specifiers) are erased at compile time and never reach the bundle,
// so they contribute nothing.
function exportedValueNames(node: ts.Node): string[] {
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    return exportedVariableNames(node);
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    hasExportModifier(node) &&
    node.name
  ) {
    return [node.name.text];
  }
  if (ts.isExportDeclaration(node)) {
    return exportedSpecifierNames(node);
  }
  return [];
}

function valueExportsOtherThanRoute(filePath: string): string[] {
  const source = ts.sys.readFile(filePath);
  if (source === undefined) {
    throw new Error(`Could not read route file: ${filePath}`);
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  const offenders: string[] = [];
  sourceFile.forEachChild((node) => {
    for (const name of exportedValueNames(node)) {
      if (name !== 'Route') offenders.push(name);
    }
  });

  return offenders;
}

describe('route file exports (code-splitting guardrail)', () => {
  it('every route file exports only `Route` (no other value exports)', () => {
    const violations: Record<string, string[]> = {};

    for (const entry of listRouteFiles()) {
      const filePath = path.join(ROUTES_DIR, entry);
      const offenders = valueExportsOtherThanRoute(filePath);
      if (offenders.length > 0) {
        violations[path.relative(ROUTES_DIR, filePath)] = offenders;
      }
    }

    expect(violations).toEqual({});
  });
});
