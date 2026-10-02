import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const BASE_TSCONFIG = path.resolve(import.meta.dirname, '../../packages/config/tsconfig.base.json');
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/**
 * Module resolution has to match the compiler's, or the closure resolves
 * specifiers to different files than the code actually loads. Read from the
 * shared base config rather than restated here, so a resolution change moves
 * both together.
 */
function resolutionOptions(): ts.CompilerOptions {
  const readResult = ts.readConfigFile(BASE_TSCONFIG, (file) => ts.sys.readFile(file));
  /* v8 ignore next 3 -- the base config is checked in beside this file; a run that
     cannot read it must stop rather than resolve against silent defaults. */
  if (readResult.error || !readResult.config) {
    throw new Error(`module-closure: cannot read ${BASE_TSCONFIG}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(BASE_TSCONFIG),
    undefined,
    BASE_TSCONFIG
  );
  return {
    ...parsed.options,
    allowJs: true,
    // Nothing here reads a type, only symbol identity and module resolution, and
    // loading the standard library costs more than the whole walk.
    noLib: true,
  };
}

/**
 * The set of first-party modules whose content determines what the entry files
 * produce, entries included, sorted so the digest does not depend on walk order.
 *
 * The walk follows every module specifier that resolves outside `node_modules`,
 * with one narrowing: a `{ named }` import or re-export follows the module that
 * *declares* the binding, reached through however many re-exports stand between,
 * rather than every module those barrels also re-export. A default import, a
 * namespace import, a side-effect-only import, an `export *` and a dynamic
 * `import()` all follow the whole target module, because each of those can
 * observe anything the target does.
 *
 * Three things that leaves out, none of which this function can close on its own.
 * A barrel forwarding a binding with `export *` declares nothing of its own, so
 * it is not in the closure and a top-level side effect added to it would not
 * invalidate the cache. Third-party code is never in the closure, so a caller
 * whose output depends on one must declare that package's manifest itself — this
 * function does not derive them, because the compiler resolves a specifier to
 * whichever package supplies its types, which for a JS library is the `@types`
 * package and the wrong version to pin. And files a generator reads at run time
 * rather than imports — fonts, design tokens, templates — are invisible to any
 * import walk and must likewise be declared alongside this closure.
 *
 * An entry that does not exist is returned as-is: the caller's cache treats a
 * missing input as "do not cache", which is what generator unit tests running
 * against a temporary root rely on.
 */
export function collectModuleClosure(entryFiles: readonly string[]): string[] {
  if (entryFiles.some((file) => !existsSync(file))) return [...entryFiles];

  const entries = new Set(entryFiles.map((file) => realpathSync(file)));
  const options = resolutionOptions();
  const program = ts.createProgram([...entries], options);
  const checker = program.getTypeChecker();

  const visited = new Set<ts.SourceFile>();
  const firstParty = new Set<string>();

  function reach(source: ts.SourceFile): void {
    if (visited.has(source)) return;
    visited.add(source);
    const resolved = realpathSync(source.fileName);
    if (resolved.includes(NODE_MODULES)) return;
    firstParty.add(resolved);
    walk(source);
  }

  function reachSymbol(symbol: ts.Symbol): void {
    /* v8 ignore next -- a symbol the checker handed back was resolved from a
       declaration, so the list is never absent. */
    for (const declaration of symbol.declarations ?? []) {
      reach(declaration.getSourceFile());
    }
  }

  /** Follow a specifier as a whole module. Nothing is reached when it does not
   *  resolve, or when it is not a literal — a computed `import()` names its
   *  target only at run time, so no walk can see it. */
  function reachModule(specifier: ts.Expression, from: ts.SourceFile): void {
    if (!ts.isStringLiteral(specifier)) return;
    const resolved = ts.resolveModuleName(specifier.text, from.fileName, options, ts.sys);
    if (!resolved.resolvedModule) return;
    const target = program.getSourceFile(resolved.resolvedModule.resolvedFileName);
    /* v8 ignore next -- the compiler builds the program by making the same
       resolution, so a specifier that resolves has its target loaded. */
    if (!target) return;
    reach(target);
  }

  function reachBinding(name: ts.ModuleExportName): void {
    const bound = checker.getSymbolAtLocation(name);
    /* v8 ignore next -- the binder gives every import and export specifier a
       symbol, whether or not its module resolves. */
    if (!bound) return;
    let symbol = bound;
    // Walked link by link rather than in one getAliasedSymbol hop, so that a
    // module re-exporting by name — which declares the specifier itself — lands
    // in the closure beside the module that declares the binding.
    while ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const next = checker.getImmediateAliasedSymbol(symbol);
      if (!next) return;
      symbol = next;
      reachSymbol(symbol);
    }
  }

  /** The named bindings a declaration pulls across, or nothing when the whole
   *  target module has to be followed instead. */
  function namedBindingsOf(
    node: ts.ImportDeclaration | ts.ExportDeclaration
  ): readonly ts.ModuleExportName[] | undefined {
    if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      return clause && ts.isNamedExports(clause) ? clause.elements.map((e) => e.name) : undefined;
    }
    const clause = node.importClause;
    if (clause?.name || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      return undefined;
    }
    return clause.namedBindings.elements.map((e) => e.name);
  }

  function reachDeclaration(
    node: ts.ImportDeclaration | ts.ExportDeclaration,
    specifier: ts.Expression,
    source: ts.SourceFile
  ): void {
    const bindings = namedBindingsOf(node);
    if (!bindings) {
      reachModule(specifier, source);
      return;
    }
    for (const binding of bindings) reachBinding(binding);
  }

  function walk(source: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        reachDeclaration(node, node.moduleSpecifier, source);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        reachDeclaration(node, node.moduleSpecifier, source);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0]
      ) {
        reachModule(node.arguments[0], source);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const source of program.getSourceFiles()) {
    if (entries.has(source.fileName)) reach(source);
  }

  // Byte order, not collation: the digest built from this list has to come out
  // the same on every machine that runs the generator.
  return [...firstParty].toSorted((left, right) => (left < right ? -1 : Number(left > right)));
}
