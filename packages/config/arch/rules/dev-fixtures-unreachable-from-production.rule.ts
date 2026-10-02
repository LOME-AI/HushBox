import path from 'node:path';
import { ts } from 'ts-morph';
import { moduleReferences } from '../lib/module-references.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import { REPO_ROOT, discoverSourceTrees, workspaceSourceTree } from '../lib/source-scope.js';
import type { ModuleReference, ModuleReferenceForm } from '../lib/module-references.js';
import type { ExportDeclaration, ImportDeclaration, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Dev-only surface is unreachable from production code — the symbol-level half
 * of `apps/api/CLAUDE.md`'s "`dev-only` routes 404 in production", which the
 * import graph must make true before a route ever runs.
 *
 * The same file's door rule is what opened the hole: "Non-slice consumers (app
 * assembly, middleware, the job registry, dev/seed) use the barrel." Several
 * slices now publish dev/E2E fixture writers on their barrels so seed and E2E
 * code reaches those slices' tables through their owner. That barrel is the
 * SAME door production code imports, and `eslint-plugin-boundaries` matches
 * element PATHS, never imported symbol names: a barrel re-export is one file to
 * it, so no descriptor set can permit a slice's real API while refusing its dev
 * fixture through the same `index.ts`. Before the doors existed the fixture
 * bodies sat in an unclassified tree and were unimportable by construction;
 * publishing them converted structurally-unreachable into reachable-by-rule.
 * This rule takes that back, the same way `no-drizzle-operators-in-barrels`
 * closes operator laundering the boundary cannot see.
 *
 * Division of labour with the lint layer, so neither gate is read as covering
 * the other's half: the boundaries plugin governs the dev TREE by path (the
 * composition root's mount of the dev manifest is a deliberate allow edge
 * there — the mount is unconditional; the barrier is the `dev-only` route
 * class, which answers 404 under a production env, pinned by
 * `apps/api/src/dev/routes.integration.test.ts`); this rule governs dev SYMBOLS
 * published from production trees, wherever a re-export chain carries them.
 *
 * WHAT A DEV FIXTURE IS, derived rather than listed: a non-test module inside
 * the api source tree whose filename begins with `dev-`. Every door published
 * so far is written that way, and the derivation is the point — a hand-kept
 * list of symbol names goes stale the day a sixth door lands and fails silent,
 * which is the failure this rule exists to end. A door added tomorrow under
 * that spelling is covered with no edit here; a door added under some other
 * spelling is not, so the naming convention IS the contract, and the violation
 * message says so. The prefix is read only inside the api tree: `dev-`-named
 * modules in the web and admin apps are ordinary production code those apps
 * import on purpose.
 *
 * WHO MAY IMPORT ONE, default-closed — everything not named here is refused:
 * the api dev tree (any module under a `dev` directory in that tree, which is
 * the fixtures' whole purpose and survives that tree moving), test files
 * anywhere, the fixture modules themselves (they compose each other), and the
 * `scripts` workspace, which drives the seed CLI through the `dev-seed` subpath
 * and never ships to the Worker.
 *
 * Re-exporting a fixture is not consuming one: an owning barrel republishing
 * its own door is the sanctioned publication, so only IMPORTS are violations,
 * while every re-export edge propagates the taint onward. `export *` of a
 * fixture module taints the re-exporting module WHOLESALE, because a star
 * publishes the fixture surface under names no reader of the barrel can tell
 * from its real API — the remedy is a named re-export, not an exemption.
 *
 * THE SUBJECT IS THE MODULE SPECIFIER, NOT ONE SYNTAX FOR IT. A module can name
 * another in more ways than a list of node kinds stays current with, so which forms
 * exist is {@link moduleReferences}' answer for the whole layer, and this rule only
 * splits them by how it must READ them: an import or export declaration is read as a
 * declaration, because the named, aliased, default and namespace bindings on it are
 * what the fixture surface is matched against; every other form carries the module
 * outside a declaration and is judged by what it binds. Anything that binds a module
 * whole is judged exactly as a namespace import is; anything that takes one name off
 * it is judged as a named import is.
 *
 * WHAT THE WALK CANNOT SEE IS MADE LOUD RATHER THAN LEFT SILENT, at the volume the
 * blindness earns. A falsified premise about the corpus throws, because every verdict
 * downstream of it is then unsound: a scanned tree holding no fixture module at all
 * (the convention was renamed, or the last door was removed and this rule should go
 * with it), and a relative code specifier in the api tree — in ANY form above —
 * resolving to no scanned file, since the re-export surface is a fixed point computed
 * project-wide and one dropped edge takes its whole subtree out of it (a CommonJS
 * `require('…')` lands here too, as this harness resolves no CJS). One caller naming a
 * module by a specifier that is not written out falsifies no premise — it is one legal
 * line this rule cannot follow — so it is an ordinary violation, failing the gate as
 * hard while the other rules still report their own results.
 *
 * WHAT REMAINS UNSEEN IS DERIVED, NOT COUNTED: this walk follows a module named by a
 * specifier the checker resolves to a scanned file, so what escapes it is exactly a
 * name that never becomes one: a specifier the checker resolves nowhere, such as an
 * `@/` alias, since this harness carries no path mapping and that spelling exists only
 * in the frontend apps, never in the api tree where the doors and their chains live;
 * or a published name carried by no specifier at all, such as the local-binding
 * re-export (`import { seed } from './dev-fixtures.js'; export { seed };`), where every
 * file able to write one is either refused at its own import or unimportable from
 * production. A module named only as text (a `/// <reference>`, an
 * `import.meta.resolve`, a `new URL(…, import.meta.url)`) binds nothing by itself, and
 * the import that would bind it names its module by a specifier this walk reads.
 */

/** The convention that declares a module a dev fixture, read on the filename. */
const FIXTURE_PREFIX = 'dev-';

/** The directory name that marks the api tree's dev scaffolding, wherever it sits. */
const DEV_DIRECTORY = 'dev';

/**
 * Both trees are anchored at the repository root rather than matched loosely:
 * `apps/sandbox/scripts` is a real directory in another workspace, and a
 * contains-`scripts/` reading of the same question would hand this rule a
 * second tree to exempt while looking identical to the one it means.
 */
const SOURCE_TREES = discoverSourceTrees(REPO_ROOT);
const API_ROOT = path.join(REPO_ROOT, workspaceSourceTree(SOURCE_TREES, 'apps/api'));
const SCRIPTS_ROOT = path.join(REPO_ROOT, workspaceSourceTree(SOURCE_TREES, 'scripts'));

/** A specifier that names code, as opposed to an asset a bundler resolves. */
const CODE_SPECIFIER = /\.[cm]?[jt]sx?$/;

const REMEDY =
  'dev fixtures are for the api dev tree, the seed toolkit and tests; production code must not import one, through however many barrels it travels.';

/** What one module publishes of the fixture surface, however it acquired it. */
interface FixtureSurface {
  /** Set when the module IS a fixture module: its own repo-relative path. */
  self?: string;
  /** Set when `export *` republished a whole fixture surface: the origin module. */
  star?: string;
  /** Published name → the fixture module the symbol was declared in. */
  readonly names: Map<string, string>;
}

/** One resolved re-export edge, resolved once and walked to a fixed point. */
interface ReexportEdge {
  readonly file: SourceFile;
  readonly target: SourceFile;
  readonly declaration: ExportDeclaration;
}

function fileName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function isFixtureModule(filePath: string): boolean {
  return (
    filePath.startsWith(API_ROOT) &&
    !isTestFile(filePath) &&
    fileName(filePath).startsWith(FIXTURE_PREFIX)
  );
}

/** The api tree's dev scaffolding, named by its directory so a move keeps it. */
function isApiDevTree(filePath: string): boolean {
  if (!filePath.startsWith(API_ROOT)) return false;
  const segments = filePath.slice(API_ROOT.length).split('/');
  return segments.slice(0, -1).includes(DEV_DIRECTORY);
}

function isAllowedConsumer(filePath: string): boolean {
  return (
    isTestFile(filePath) ||
    isFixtureModule(filePath) ||
    isApiDevTree(filePath) ||
    filePath.startsWith(SCRIPTS_ROOT)
  );
}

function surfaceFor(surfaces: Map<SourceFile, FixtureSurface>, file: SourceFile): FixtureSurface {
  const existing = surfaces.get(file);
  if (existing !== undefined) return existing;
  const created: FixtureSurface = { names: new Map<string, string>() };
  surfaces.set(file, created);
  return created;
}

/** True when the name was new, so the fixed point knows it has more to do. */
function addName(surface: FixtureSurface, name: string, origin: string): boolean {
  if (surface.names.has(name)) return false;
  surface.names.set(name, origin);
  return true;
}

/** The origin to blame when a whole surface travels under one new name. */
function anyOrigin(surface: FixtureSurface): string | undefined {
  return surface.self ?? surface.star ?? [...surface.names.values()][0];
}

function applyStarEdge(
  declaration: ExportDeclaration,
  source: FixtureSurface,
  own: FixtureSurface
): boolean {
  const namespaceName = declaration.getNamespaceExport()?.getName();
  if (namespaceName !== undefined) {
    const origin = anyOrigin(source);
    return origin !== undefined && addName(own, namespaceName, origin);
  }
  const wholesale = source.self ?? source.star;
  if (wholesale !== undefined) {
    if (own.star !== undefined) return false;
    own.star = wholesale;
    return true;
  }
  let changed = false;
  for (const [name, origin] of source.names) changed = addName(own, name, origin) || changed;
  return changed;
}

function applyEdge(edge: ReexportEdge, surfaces: Map<SourceFile, FixtureSurface>): boolean {
  const source = surfaces.get(edge.target);
  if (source === undefined) return false;
  const own = surfaceFor(surfaces, edge.file);
  if (edge.declaration.isNamespaceExport()) return applyStarEdge(edge.declaration, source, own);

  const wholesale = source.self ?? source.star;
  let changed = false;
  for (const specifier of edge.declaration.getNamedExports()) {
    const sourceName = specifier.getName();
    const origin = wholesale ?? source.names.get(sourceName);
    if (origin === undefined) continue;
    const outwardName = specifier.getAliasNode()?.getText() ?? sourceName;
    changed = addName(own, outwardName, origin) || changed;
  }
  return changed;
}

/**
 * Every module that publishes any part of the fixture surface: the fixture
 * modules themselves, then the fixed point over re-export edges, so a symbol is
 * still a fixture symbol however many barrels it has passed through.
 */
function fixtureSurfaces(
  project: Project,
  fixtureModules: readonly SourceFile[]
): Map<SourceFile, FixtureSurface> {
  const surfaces = new Map<SourceFile, FixtureSurface>();
  for (const module of fixtureModules) {
    surfaceFor(surfaces, module).self = relativePath(module);
  }

  const edges: ReexportEdge[] = [];
  for (const file of project.getSourceFiles()) {
    for (const declaration of file.getExportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined) edges.push({ file, target, declaration });
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) changed = applyEdge(edge, surfaces) || changed;
  }
  return surfaces;
}

function wholesaleMessage(surface: FixtureSurface): string | undefined {
  if (surface.self !== undefined) {
    return `imports the dev-fixture module "${surface.self}" — ${REMEDY}`;
  }
  if (surface.star !== undefined) {
    return `imports a module that republishes the dev-fixture module "${surface.star}" wholesale with \`export *\`, so its whole surface is fixture surface — name the re-exports instead, and ${REMEDY}`;
  }
  return undefined;
}

function namedMessage(name: string, origin: string): string {
  return `imports "${name}", a dev fixture declared in "${origin}" — ${REMEDY}`;
}

function importViolations(
  declaration: ImportDeclaration,
  filePath: string,
  surface: FixtureSurface
): ArchViolation[] {
  const line = declaration.getStartLineNumber();
  const wholesale = wholesaleMessage(surface);
  if (wholesale !== undefined) {
    return [{ file: filePath, line, message: `Production code ${wholesale}` }];
  }

  const namespaceName = declaration.getNamespaceImport()?.getText();
  if (namespaceName !== undefined) {
    const origin = anyOrigin(surface);
    if (origin === undefined) return [];
    const imported = `* as ${namespaceName}`;
    return [{ file: filePath, line, message: `Production code ${namedMessage(imported, origin)}` }];
  }

  const violations: ArchViolation[] = [];
  const defaultOrigin =
    declaration.getDefaultImport() === undefined ? undefined : surface.names.get('default');
  if (defaultOrigin !== undefined) {
    violations.push({
      file: filePath,
      line,
      message: `Production code ${namedMessage('default', defaultOrigin)}`,
    });
  }
  for (const specifier of declaration.getNamedImports()) {
    const origin = surface.names.get(specifier.getName());
    if (origin === undefined) continue;
    violations.push({
      file: filePath,
      line: specifier.getStartLineNumber(),
      message: `Production code ${namedMessage(specifier.getName(), origin)}`,
    });
  }
  return violations;
}

function wholeSurfaceMessage(form: string, origin: string): string {
  return `takes a fixture-carrying module's whole surface through \`${form}\`, which publishes a dev fixture declared in "${origin}" — ${REMEDY}`;
}

/**
 * One place a module names another outside an import or export declaration,
 * resolved against the project. `specifier` is absent when it is not written out,
 * which is the one form nothing can resolve — {@link computedSpecifierViolations}
 * reports on it.
 */
interface ResolvedReference {
  readonly specifier: string | undefined;
  readonly target: SourceFile | undefined;
  readonly line: number;
  /** As written, for the message. */
  readonly text: string;
  /** The single name the form takes off the module, when it takes one. */
  readonly member: string | undefined;
}

/** The forms this rule reads off the shared walk; declarations are read as declarations. */
const OUTSIDE_DECLARATIONS: ReadonlySet<ModuleReferenceForm> = new Set([
  'dynamic-import',
  'require',
  'import-type',
  'import-equals',
]);

/**
 * A call form prints as its callee and specifier rather than verbatim, so a
 * multi-line `await import(…)` argument list does not land in a violation
 * message; every other form is short enough to print as written.
 */
function referenceText(reference: ModuleReference, file: SourceFile): string {
  const node = reference.node;
  if (!ts.isCallExpression(node)) return node.getText(file.compilerNode);
  return `${node.expression.getText(file.compilerNode)}(${reference.specifier ?? '…'})`;
}

/** The module a written specifier names, asked of the checker that resolved the imports. */
function targetOf(reference: ModuleReference, file: SourceFile): SourceFile | undefined {
  if (reference.literal === undefined) return undefined;
  const declaration = file
    .getProject()
    .getTypeChecker()
    .compilerObject.getSymbolAtLocation(reference.literal)?.declarations?.[0];
  return declaration !== undefined && ts.isSourceFile(declaration)
    ? file.getProject().getSourceFile(declaration.fileName)
    : undefined;
}

/** Every module reference a file writes outside an import or export declaration. */
function outsideDeclarationReferences(file: SourceFile): ResolvedReference[] {
  return moduleReferences(file.compilerNode)
    .filter((reference) => OUTSIDE_DECLARATIONS.has(reference.form))
    .map((reference) => ({
      specifier: reference.specifier,
      target: targetOf(reference, file),
      line: reference.line,
      text: referenceText(reference, file),
      member: reference.member,
    }));
}

/**
 * A dynamic import, an import-equals or an `import('…')` type takes the module
 * whole, exactly as a namespace import does — except the type form, which may
 * qualify one name off it.
 */
function referenceViolations(
  reference: ResolvedReference,
  filePath: string,
  surface: FixtureSurface
): ArchViolation[] {
  const { line } = reference;
  const wholesale = wholesaleMessage(surface);
  if (wholesale !== undefined) {
    return [{ file: filePath, line, message: `Production code ${wholesale}` }];
  }
  if (reference.member !== undefined) {
    const origin = surface.names.get(reference.member);
    return origin === undefined
      ? []
      : [
          {
            file: filePath,
            line,
            message: `Production code ${namedMessage(reference.member, origin)}`,
          },
        ];
  }
  const origin = anyOrigin(surface);
  return origin === undefined
    ? []
    : [
        {
          file: filePath,
          line,
          message: `Production code ${wholeSurfaceMessage(reference.text, origin)}`,
        },
      ];
}

/**
 * A specifier assembled at runtime names a module no static walk can follow, so the
 * rule cannot stand over that call — it says exactly that and fails the gate. It is
 * reported rather than thrown because one such line falsifies nothing this rule
 * concluded elsewhere: it is one developer writing one legal line, and a stack trace
 * in place of the other rules' results is a heavier answer than the fact deserves.
 * Only production api files reach here — the dev tree, tests and the scripts
 * workspace may compute freely, being allowed to hold a fixture either way.
 */
function computedSpecifierViolations(
  filePath: string,
  references: readonly ResolvedReference[]
): ArchViolation[] {
  return references
    .filter((reference) => reference.specifier === undefined)
    .map((reference) => ({
      file: filePath,
      line: reference.line,
      message:
        `Production code names a module through \`${reference.text}\`, whose specifier is not ` +
        'written out, so this rule cannot verify it does not reach a dev fixture — write the ' +
        'specifier out, or move the caller into the api dev tree.',
    }));
}

/** Every fixture symbol one file imports, whichever module published it. */
function consumerViolations(
  file: SourceFile,
  surfaces: ReadonlyMap<SourceFile, FixtureSurface>,
  references: readonly ResolvedReference[]
): ArchViolation[] {
  const filePath = relativePath(file);
  const surfaceOf = (target: SourceFile | undefined): FixtureSurface | undefined =>
    target === undefined ? undefined : surfaces.get(target);
  return [
    ...file.getImportDeclarations().flatMap((declaration) => {
      const surface = surfaceOf(declaration.getModuleSpecifierSourceFile());
      return surface === undefined ? [] : importViolations(declaration, filePath, surface);
    }),
    ...references.flatMap((reference) => {
      const surface = surfaceOf(reference.target);
      return surface === undefined ? [] : referenceViolations(reference, filePath, surface);
    }),
    ...(file.getFilePath().startsWith(API_ROOT)
      ? computedSpecifierViolations(filePath, references)
      : []),
  ];
}

/**
 * The rule's own subject going missing reports nothing, so it throws instead:
 * every check would keep passing over a set that no longer exists.
 */
function assertFixtureModulesExist(fixtureModules: readonly SourceFile[]): void {
  if (fixtureModules.length > 0) return;
  throw new Error(
    'dev-fixtures-unreachable-from-production: the scanned tree holds no dev-fixture module ' +
      `(a non-test file named "${FIXTURE_PREFIX}*" in the api source tree), so this rule stands ` +
      'over nothing. Either the naming convention it derives from was changed — point the rule ' +
      'at the new one — or the last dev door was removed, and the rule should go with it.'
  );
}

/**
 * A dropped edge is worse than a reported one: it takes its whole subtree out
 * of the walk while the rule goes on passing. The api tree is what is asserted
 * — every fixture lives there and every chain that carries one starts there, so
 * a chain broken at its root is invisible everywhere. Asset specifiers name no
 * code and are skipped by extension; `@/`-aliased specifiers resolve nowhere in
 * this harness and exist only in the frontend apps, never in the api tree.
 */
function unresolvedEdgesIn(file: SourceFile, references: readonly ResolvedReference[]): string[] {
  const declarations = [...file.getImportDeclarations(), ...file.getExportDeclarations()];
  const specifiers = [
    ...declarations.map((declaration) => ({
      specifier: declaration.getModuleSpecifierValue(),
      target: declaration.getModuleSpecifierSourceFile(),
    })),
    ...references,
  ];
  return specifiers
    .filter(({ specifier, target }) => {
      if (!specifier?.startsWith('.')) return false;
      return CODE_SPECIFIER.test(specifier) && target === undefined;
    })
    .map(({ specifier }) => `${relativePath(file)} → ${String(specifier)}`);
}

function assertApiEdgesResolve(
  project: Project,
  references: ReadonlyMap<SourceFile, readonly ResolvedReference[]>
): void {
  const unresolved = project
    .getSourceFiles()
    .filter((file) => file.getFilePath().startsWith(API_ROOT))
    .flatMap((file) => unresolvedEdgesIn(file, references.get(file) ?? []));
  if (unresolved.length === 0) return;
  throw new Error(
    'dev-fixtures-unreachable-from-production: these api-tree module references resolve to no ' +
      'scanned file, so the fixture surface they might carry is invisible to this rule:\n' +
      unresolved.join('\n')
  );
}

const rule: ArchRule = {
  name: 'dev-fixtures-unreachable-from-production',
  check(project) {
    const fixtureModules = project
      .getSourceFiles()
      .filter((file) => isFixtureModule(file.getFilePath()));
    assertFixtureModulesExist(fixtureModules);

    const references = new Map<SourceFile, readonly ResolvedReference[]>(
      project.getSourceFiles().map((file) => [file, outsideDeclarationReferences(file)])
    );
    assertApiEdgesResolve(project, references);

    const surfaces = fixtureSurfaces(project, fixtureModules);
    return project
      .getSourceFiles()
      .filter((file) => !isAllowedConsumer(file.getFilePath()))
      .flatMap((file) => consumerViolations(file, surfaces, references.get(file) ?? []));
  },
};

export default rule;
