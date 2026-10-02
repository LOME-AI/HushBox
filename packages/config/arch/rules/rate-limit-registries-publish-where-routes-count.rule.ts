import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { assertNamedPathsExist, failWith, isTestFile, relativePath } from '../lib/paths.js';
import type { ExportDeclaration, ImportDeclaration, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A slice's ROUTE MODULES import a counting function from its rate-limit
 * registry EXACTLY WHEN its domain barrel republishes that registry. The rule
 * is written in prose at `apps/api/src/slices/chat/domain/index.ts`, above the
 * republication it explains; this is what holds it, in both directions.
 *
 * A slice's route modules are its `routes.ts` together with every non-test
 * module under its `routes/` directory ({@link isRouteModule}). Reading
 * `routes.ts` alone would take a slice out of this rule's reach the moment it
 * split its routes into group modules — and out of reach SILENTLY, since a
 * counting import nothing looks at refuses nothing. The registry side already
 * refuses to pass over a subject that has moved (below); the routes side must
 * not be able to.
 *
 * Why the shape differs per slice at all:
 * `packages/config/eslint-extensions/boundaries.config.mjs` admits a route to
 * its own domain BARREL and to the middleware, and to no other domain module —
 * so a counting function a route calls has to arrive through
 * `domain/index.ts`, while a slice whose counting sits inside `domain/` needs
 * no such door and publishes its registry off the slice barrel instead.
 * Republishing a registry no route counts through opens that door for nothing;
 * counting off a registry the domain barrel does not publish reaches a counter
 * by a path the barrel does not answer for.
 *
 * # the antecedent, and the two readings it is NOT
 *
 * A counting function is one the REGISTRY exports AND that spends through
 * `lib/rate-limit`'s primitive. Neither half alone answers the question.
 *
 * Not the registry's exports alone: every registry publishes its DEFINITIONS
 * there too, and a route reaching for a definition has counted nothing. Not
 * "a counting function" alone either: one slice declares one outside its
 * registry — `apps/api/src/slices/chat/domain/trial/quota.ts` — and calls it
 * from its routes, and that call says nothing about where the REGISTRY belongs.
 *
 * And not the posture declaration, which reads like a ready-made predicate and
 * is not one: the slice declaring the most flow-counted routes in the tree
 * correctly takes the other shape, because it counts inside `domain/`. Where a
 * slice counts and which door its registry needs are different questions, and
 * the prose that keyed on the first was corrected for exactly that.
 *
 * # the slack it permits, deliberately
 *
 * Republication is judged per MODULE, never per symbol. Both slices that
 * republish today also republish definitions their routes never import, so a
 * per-symbol reading would refuse both. That slack is load-bearing rather than
 * tolerated: each slice barrel routes those definitions outward THROUGH the
 * domain barrel, so narrowing it needs a second export statement in each slice.
 *
 * # what it does not read
 *
 * One hop: a registry reaching the domain barrel through an intermediate
 * module is not seen as republished. A type-only re-export publishes no value,
 * so it is not a republication here. A test module under the routes directory
 * is not a route module: a counter a test imports proves no route counts
 * through it, and would launder a republication nothing spends. And the
 * registry is the module at
 * `<slice>/domain/rate-limit.ts` — one written under another name is invisible,
 * which is why a project holding no such module at all throws rather than
 * reporting a clean pass over a subject that has moved.
 *
 * The classifier is narrower than the definition above, and its reach is what
 * it READS rather than a list of what it misses. On the registry side: a call
 * whose callee is a bare identifier bound by this module's own named import,
 * with a specifier naming {@link RATE_LIMIT_LIB}, of a counting primitive,
 * written inside a function declaration or a function-valued constant the
 * registry module itself declares, and published
 * by the registry under some name. On the routes side: named import
 * specifiers, in any of the slice's route modules. Everything else is invisible — spending through a local
 * helper, a counter a factory call returns, a member-expression callee, a
 * counter re-exported from a sibling module, a route taking its counter off a
 * namespace import are instances, not the set.
 *
 * That blindness fails in two directions. Where the domain barrel republishes
 * the registry, an invisible counter cannot satisfy the routes-side arm, so
 * unless a visible one satisfies it instead the slice is refused — a FALSE
 * POSITIVE, carrying whichever refusal message fits what the classifier could
 * still see. Where the barrel does not republish, a counter a route spends
 * invisibly is never reported — a SILENT MISS of the routes-side arm, the
 * direction this gate exists for, and so the worse one.
 */

const RULE = 'rate-limit-registries-publish-where-routes-count';

const fail: (message: string) => never = failWith(RULE);

/** The slice tree this rule stands over. */
const SLICES_ROOT = 'apps/api/src/slices/';

/** A slice's registry, relative to the slice root, and the pattern that finds one. */
const REGISTRY_PATH = 'domain/rate-limit.ts';
const REGISTRY_PATTERN = new RegExp(`(?:^|/)${SLICES_ROOT}[^/]+/${REGISTRY_PATH}$`);

/** The barrel a route may import, and the route modules that may import it. */
const DOMAIN_BARREL_PATH = 'domain/index.ts';
const ROUTES_PATH = 'routes.ts';
const ROUTES_DIRECTORY = 'routes/';

/**
 * One file in each form {@link isRouteModule} recognises, so the two spellings
 * are measured against the tree on every run rather than remembered. A tree
 * that writes its routes somewhere else leaves the routes-side arm reading no
 * module at all — which refuses every republication where the registry side is
 * loud, and misses every counted import where it is not.
 */
const ROUTE_MODULE_WITNESSES = [
  `${SLICES_ROOT}chat/${ROUTES_PATH}`,
  `${SLICES_ROOT}chat/${ROUTES_DIRECTORY}refusals.ts`,
];

const LAYOUT_MOVED =
  'These are the two spellings the routes side reads — a slice routes module, and a module under ' +
  'a slice routes directory. Point this rule at where the slices write their routes now, in the ' +
  'change that moves them.';

/** The module publishing the counting primitives, and the primitives that spend. */
const RATE_LIMIT_LIB = '/lib/rate-limit/';
const COUNTING_PRIMITIVES = new Set(['consume', 'consumeLayers']);

/** A module path with its extension dropped, so a `.js` specifier meets its `.ts` file. */
function moduleKey(filePath: string): string {
  return filePath.replace(/\.[cm]?[jt]sx?$/, '');
}

/** A repo-local specifier resolved against the file that writes it, extension dropped. */
function resolvedSpecifier(fromPath: string, specifier: string): string {
  return moduleKey(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier)));
}

/** The `apps/api/src/slices/<slice>/` prefix of a registry path, however the project is rooted. */
function sliceRootOf(registryPath: string): string {
  return registryPath.slice(0, registryPath.length - REGISTRY_PATH.length);
}

/**
 * The same prefix as the repository writes it. A scanned path carries whatever
 * the project is rooted at, which a message must not repeat back — the `file`
 * field already locates the violation, and a message naming a SIBLING module
 * should name it the way a reader would type it.
 */
function sliceLabelOf(sliceRoot: string): string {
  return sliceRoot.slice(sliceRoot.lastIndexOf(SLICES_ROOT));
}

/** True when any call in the subtree names one of `callees` directly. */
function callsAny(node: Node, callees: ReadonlySet<string>): boolean {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    return Node.isIdentifier(callee) && callees.has(callee.getText());
  });
}

/** The local names this module binds to `lib/rate-limit`'s counting primitives. */
function primitiveBindings(file: SourceFile): Set<string> {
  const bindings = new Set<string>();
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    if (!declaration.getModuleSpecifierValue().includes(RATE_LIMIT_LIB)) continue;
    for (const specifier of declaration.getNamedImports()) {
      if (!COUNTING_PRIMITIVES.has(specifier.getName())) continue;
      bindings.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
    }
  }
  return bindings;
}

/** Function declarations that spend through one of `primitives`, added by local name. */
function collectFunctionCounters(
  file: SourceFile,
  primitives: ReadonlySet<string>,
  into: Set<string>
): void {
  for (const declaration of file.getFunctions()) {
    const name = declaration.getName();
    if (name !== undefined && callsAny(declaration, primitives)) into.add(name);
  }
}

/** Function-valued constants that spend through one of `primitives`, added by local name. */
function collectVariableCounters(
  file: SourceFile,
  primitives: ReadonlySet<string>,
  into: Set<string>
): void {
  for (const declaration of file.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (initializer === undefined) continue;
    if (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer)) continue;
    if (callsAny(initializer, primitives)) into.add(declaration.getName());
  }
}

/** Functions declared in the module that spend through one of `primitives`, by local name. */
function localCounters(file: SourceFile, primitives: ReadonlySet<string>): Set<string> {
  const counters = new Set<string>();
  if (primitives.size === 0) return counters;
  collectFunctionCounters(file, primitives, counters);
  collectVariableCounters(file, primitives, counters);
  return counters;
}

/** Exported function declarations, each publishing itself under its own name. */
function collectPublishedFunctions(file: SourceFile, into: Map<string, string>): void {
  for (const declaration of file.getFunctions()) {
    const name = declaration.getName();
    if (name !== undefined && declaration.hasExportKeyword()) into.set(name, name);
  }
}

/** Exported constants, each publishing itself under its own name. */
function collectPublishedVariables(file: SourceFile, into: Map<string, string>): void {
  for (const statement of file.getVariableStatements()) {
    if (!statement.hasExportKeyword()) continue;
    for (const declaration of statement.getDeclarations()) {
      into.set(declaration.getName(), declaration.getName());
    }
  }
}

/** Local `export { … }` statements, which may publish a declaration under another name. */
function collectPublishedByStatement(file: SourceFile, into: Map<string, string>): void {
  for (const declaration of file.getExportDeclarations()) {
    if (declaration.isTypeOnly() || declaration.getModuleSpecifier() !== undefined) continue;
    for (const specifier of declaration.getNamedExports()) {
      if (specifier.isTypeOnly()) continue;
      const local = specifier.getName();
      into.set(specifier.getAliasNode()?.getText() ?? local, local);
    }
  }
}

/** Each value name the module publishes, mapped to the local declaration it names. */
function publishedLocals(file: SourceFile): Map<string, string> {
  const published = new Map<string, string>();
  collectPublishedFunctions(file, published);
  collectPublishedVariables(file, published);
  collectPublishedByStatement(file, published);
  return published;
}

/** The names under which a registry publishes a function that spends a counter. */
function countingExports(registry: SourceFile): Set<string> {
  const counters = localCounters(registry, primitiveBindings(registry));
  const exported = new Set<string>();
  for (const [published, local] of publishedLocals(registry)) {
    if (counters.has(local)) exported.add(published);
  }
  return exported;
}

/** The barrel's value re-export of the registry module, when it carries one. */
function republication(barrel: SourceFile, registryPath: string): ExportDeclaration | undefined {
  const barrelPath = relativePath(barrel);
  return barrel.getExportDeclarations().find((declaration) => {
    if (declaration.isTypeOnly()) return false;
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier?.startsWith('.') !== true) return false;
    return resolvedSpecifier(barrelPath, specifier) === moduleKey(registryPath);
  });
}

/** One route import of a counting function, at the specifier that writes it. */
interface CountedImport {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

/** The counting functions one import declaration takes, at the specifiers that write them. */
function collectCountedImports(
  declaration: ImportDeclaration,
  counting: ReadonlySet<string>,
  file: string,
  into: CountedImport[]
): void {
  if (declaration.isTypeOnly()) return;
  for (const specifier of declaration.getNamedImports()) {
    if (specifier.isTypeOnly()) continue;
    const name = specifier.getName();
    if (!counting.has(name)) continue;
    into.push({ name, file, line: specifier.getStartLineNumber() });
  }
}

/** Every counting function one route module imports, whatever module it takes it from. */
function moduleCountedImports(routes: SourceFile, counting: ReadonlySet<string>): CountedImport[] {
  const counted: CountedImport[] = [];
  const file = relativePath(routes);
  for (const declaration of routes.getImportDeclarations()) {
    collectCountedImports(declaration, counting, file, counted);
  }
  return counted;
}

/**
 * A route module of the slice rooted at `sliceRoot`: its `routes.ts`, or a
 * module under its `routes/` directory. The slice root is the whole prefix, so
 * a module answers for one slice only — a route group under another slice's
 * routes directory counts nothing here.
 */
function isRouteModule(filePath: string, sliceRoot: string): boolean {
  if (isTestFile(filePath)) return false;
  return (
    filePath === `${sliceRoot}${ROUTES_PATH}` ||
    filePath.startsWith(`${sliceRoot}${ROUTES_DIRECTORY}`)
  );
}

/** Every counting function the slice's route modules import, across all of them. */
function countedImports(
  files: ReadonlyMap<string, SourceFile>,
  sliceRoot: string,
  counting: ReadonlySet<string>
): CountedImport[] {
  const counted: CountedImport[] = [];
  for (const [filePath, file] of files) {
    if (!isRouteModule(filePath, sliceRoot)) continue;
    counted.push(...moduleCountedImports(file, counting));
  }
  return counted;
}

/** Why a republication is refused: the counting functions no route imported. */
function republicationMessage(sliceRoot: string, counting: ReadonlySet<string>): string {
  const slice = sliceLabelOf(sliceRoot);
  const clause =
    counting.size === 0
      ? `${slice}${REGISTRY_PATH} exports no counting function at all, so no route can count through it`
      : `neither ${slice}${ROUTES_PATH} nor a module under ${slice}${ROUTES_DIRECTORY} imports any of the counting functions it exports (${[...counting].toSorted((a, b) => a.localeCompare(b)).join(', ')})`;
  return (
    `this domain barrel republishes ${REGISTRY_PATH}, but ${clause}. A registry reaches the ` +
    'domain barrel to put a counting function where a route may import it — a slice that counts ' +
    'inside domain/ publishes its registry off the slice barrel instead. Republished definitions ' +
    'are not the question; a counted function is.'
  );
}

/** Why a route's counting import is refused: the barrel publishes no registry to have supplied it. */
function unpublishedCounterMessage(name: string, sliceRoot: string): string {
  const slice = sliceLabelOf(sliceRoot);
  return (
    `this route imports ${name}, which ${slice}${REGISTRY_PATH} publishes as a counting ` +
    `function, while ${slice}${DOMAIN_BARREL_PATH} republishes that registry nowhere — so the ` +
    'route spends a counter through a door the domain barrel does not answer for. Republish the ' +
    'registry through the domain barrel, or count inside domain/.'
  );
}

/** The scanned files this rule reads, keyed by the path a violation would report. */
function filesByPath(project: Project): Map<string, SourceFile> {
  const files = new Map<string, SourceFile>();
  for (const sourceFile of project.getSourceFiles()) {
    files.set(relativePath(sourceFile), sourceFile);
  }
  return files;
}

/** The biconditional, judged for the one slice this registry belongs to. */
function sliceViolations(
  files: ReadonlyMap<string, SourceFile>,
  registryPath: string,
  registry: SourceFile
): ArchViolation[] {
  const sliceRoot = sliceRootOf(registryPath);
  const barrel = files.get(`${sliceRoot}${DOMAIN_BARREL_PATH}`);

  const counting = countingExports(registry);
  const republished = barrel === undefined ? undefined : republication(barrel, registryPath);
  const counted = countedImports(files, sliceRoot, counting);

  if (republished === undefined) {
    return counted.map(({ name, file, line }) => ({
      file,
      line,
      message: unpublishedCounterMessage(name, sliceRoot),
    }));
  }
  if (counted.length > 0) return [];
  return [
    {
      file: relativePath(republished.getSourceFile()),
      line: republished.getStartLineNumber(),
      message: republicationMessage(sliceRoot, counting),
    },
  ];
}

const rule: ArchRule = {
  name: RULE,
  check(project: Project): ArchViolation[] {
    assertNamedPathsExist(RULE, project, ROUTE_MODULE_WITNESSES, LAYOUT_MOVED);
    const files = filesByPath(project);
    const violations: ArchViolation[] = [];
    let registriesSeen = 0;

    for (const [registryPath, registry] of files) {
      if (!REGISTRY_PATTERN.test(registryPath)) continue;
      registriesSeen += 1;
      violations.push(...sliceViolations(files, registryPath, registry));
    }

    if (registriesSeen === 0) {
      fail(
        `no slice under ${SLICES_ROOT} declares a ${REGISTRY_PATH}, so this rule has no registry ` +
          'to judge and would pass over every slice in silence. The registries were renamed, ' +
          'moved, or left the scanned scope — point this rule at where a slice writes one now.'
      );
    }

    return violations;
  },
};

export default rule;
