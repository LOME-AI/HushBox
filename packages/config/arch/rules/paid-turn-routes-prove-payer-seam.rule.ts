import { Node, SyntaxKind } from 'ts-morph';
import { assertNamedPathsExist, relativePath } from '../lib/paths.js';
import {
  calleeName,
  declarationsWhere,
  handlerNode,
  isApiSourceFile,
  namedDeclarations,
  referencesIdentifier,
  routeRegistrations,
} from '../lib/route-shapes.js';
import type {
  ExportDeclaration,
  ExportSpecifier,
  ImportSpecifier,
  Project,
  SourceFile,
} from 'ts-morph';
import type { NamedDeclaration, RouteRegistration } from '../lib/route-shapes.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The payer-resolution seam decides which wallet funds a turn and applies the
 * model-selection gates against that payer, so a turn route able to start a paid
 * run without passing through it ships a silent bypass. That is not
 * hypothetical: the guest send accepted a premium model from a free-tier sender
 * because it resolved a payer of its own, and a third turn route was found doing
 * the same. Consolidating the gates into one seam fixed those instances; this
 * rule is what stops a fourth turn route from repeating them, because "one call
 * site" is otherwise grep-provable rather than enforced.
 *
 * # two clauses
 *
 *  - **The seam stays one call site.** `resolveTurnContext` is the payer freeze;
 *    a second caller is a second place the gates can be forgotten, so every call
 *    site is reported once there is more than one.
 *  - **Every route that starts a paid run passes through the seam.** Scope comes
 *    from the run body's `mode: 'paid'` discriminant — a marker independent of
 *    the gate, so deleting the seam call cannot also delete the reason the route
 *    is in scope. A trial run declares `mode: 'trial'` and resolves no payer, so
 *    it is out of scope by construction rather than by exception. Both the
 *    marker and the seam call are read from AST nodes, never from handler text,
 *    because node text carries comments — a comment naming the seam is not a
 *    call to it, and a comment naming the paid mode is not a paid run.
 *
 * # where the marker may sit: the slice's route group
 *
 * The marker is read across the whole route group a registering module belongs
 * to — the slice's `routes.ts` together with every module under its `routes/`
 * directory ({@link routeGroupOf}) — because a slice that splits its routes into
 * group modules otherwise takes its paid routes out of scope by moving the run
 * body one file away. That failure is silent: the gate stays green while it
 * covers less, which is the one direction nothing reports.
 *
 * A sibling's declaration scopes a route on its NAME alone, with no import
 * binding required, and that is the deliberate difference from the proof-side
 * widening `route-shapes.ts` carries. A binding requirement would make an
 * unbound marker invisible, and an invisible marker SUBTRACTS a route from the
 * checked set; a spurious one only ENLARGES it, which is a refusal a reader
 * sees. The directional rule in `route-shapes.ts` picks the loud side, and here
 * that means reading generously.
 *
 * Generously, but the name-only match alone is not generous enough: a handler
 * calling a run body the group renamed on its way over spells a name no module
 * declares. So the group's declarations are read under further names too: the
 * names an export specifier renames them to
 * ({@link reexportedGroupDeclarations}), the names a module's default slot
 * carries them under ({@link defaultPublications}), and the names the
 * registering module binds them to ({@link boundGroupDeclarations}). Each of
 * those only adds names, so none can withhold a route the name match already
 * scopes; what they reach, and therefore what they do not, is derived below.
 *
 * The group key carries the slice name, so two modules share a group only when
 * they belong to the same slice: a marker under one slice's routes scopes
 * nothing in another's.
 *
 * # limits, stated so the rule is not over-trusted
 *
 * A handler defined in another file carries no visible paid marker and is not
 * flagged here; `mutating-routes-prove-idempotency` refuses an out-of-file
 * handler on any mutating route, and every paid turn route is a POST.
 *
 * A run mode reaching the run body through a binding (`mode: runMode`) is not
 * read, so a route carrying no other marker falls out of scope. A mode written
 * into the body stays in scope whether it is a literal or a conditional over
 * literals, because the marker is then inside the assigned expression. Closing
 * the binding is not one answer: where it is a constant of the declaring
 * module, reading it is the single syntactic hop this rule already takes for
 * `export default <name>`; where it is a parameter or a computed value it is
 * the type flow this layer's syntactic-only contract excludes.
 *
 * A second re-export hop inside one group is not followed: what a module
 * publishes is read one hop off the declarations, so a name renamed twice on
 * its way over, or a default slot forwarded through two modules, publishes
 * nothing the marker scope sees. Following a chain is the fixed point
 * `dev-fixtures-unreachable-from-production.rule.ts` runs over the whole tree;
 * one hop is the depth here because a chain inside one slice's route group
 * means a second module whose only job is forwarding.
 *
 * Each limit was established by running the rule over the construction it
 * names.
 *
 * # what the readers reach, and therefore where the boundary is
 *
 * Stated as what the readers reach rather than as a list of spellings: a list
 * of shapes is a claim the next spelling falsifies, while what a function
 * reaches is checkable against the function.
 *
 *  - {@link namedDeclarations} collects each group module's top-level function
 *    and variable declarations, under the names those declarations carry.
 *  - {@link renamedBinding} reads one import or export specifier — the name the
 *    other module uses, and the rename. {@link reexportedGroupDeclarations}
 *    applies it to a module's export statements, so a group declaration is
 *    reachable under a name an export specifier renames it to.
 *  - The default slot has four readers. {@link declaredDefaults} reaches a
 *    function declaration carrying the default keyword, and the expression an
 *    `export default` assigns — resolved to the module's own declaration when
 *    that expression names one. {@link localDefaults} adds what a
 *    specifier-less `export { X as default };` of the module renames into the
 *    slot. {@link forwardedDefaults} reaches a group sibling's local slot
 *    through an `export { default … } from` specifier, under whatever name the
 *    forward gives it. {@link defaultPublications} is a module's whole slot:
 *    what it declares there, plus what it republishes or forwards there.
 *  - {@link boundGroupDeclarations} reads the registering module's own import
 *    declarations and binds all of the above under the local names that module
 *    gives them.
 *
 * The boundary of the group's publications is everything those readers do not
 * reach, and it is nearer the shapes people write than the sections above
 * might suggest. Two examples of what falls outside it, among others:
 *
 * A value REBOUND rather than renamed. `export const buildRunStartBody =
 * paidRunStartBody;` in a group module is collected by
 * {@link namedDeclarations} under its own name, and the node collected with
 * it is the binding, which carries no marker; the only place a reader of the
 * group's publications follows an identifier to the declaration it names is
 * the default slot. The same holds for that assignment made locally in the
 * registering module, and for a key of an exported aggregate (`export const
 * bodies = { build: paidRunStartBody }`, reached as `bodies.build(run)`).
 * This is the shape an ordinary refactor arrives at, and `apps/api/src`
 * writes it elsewhere
 * (`apps/api/src/slices/newsletter/adapters/subscriber-retention.ts`), so
 * nothing about the tree's habits keeps a route group clear of it.
 *
 * A CLASS, in any position, because neither reader that could admit one does:
 * {@link namedDeclarations} collects functions and variable declarations, and
 * {@link declaredDefaults} reads the slot for a function declaration and an
 * assignment. So `export default class RunBodies { static paid = { mode:
 * 'paid' }; }` taken as a static off the importer's local name is outside,
 * and so is the same class exported under its own name. No module of a
 * slice's route group fills a default slot in any spelling; the Worker entry
 * at `apps/api/src/index.ts` fills one and sits in no route group.
 *
 * A shape that starts appearing in a route group is read by extending the
 * readers above. A shape needing a SECOND hop is not: that depth belongs to the fixed point
 * `dev-fixtures-unreachable-from-production.rule.ts` runs, and a special case
 * here would buy one construction at the cost of the one-hop property that
 * makes every reading above terminate.
 *
 * Each reach and non-reach claim here was established by building the
 * publication shape it describes and running this rule over it.
 */

const RULE = 'paid-turn-routes-prove-payer-seam';

const RUN_MODE_PROPERTY = 'mode';
const PAID_MODE = 'paid';

/** The name a module's default export is published and imported under. */
const DEFAULT_EXPORT = 'default';

const PAYER_FREEZE = 'resolveTurnContext';
const SEAM = 'resolveGatedTurnContext';

/**
 * The slice route group a module belongs to: its `routes.ts` and every module
 * under its `routes/` directory answer with the prefix the two share. The slice
 * name is inside that prefix, which is the whole of the per-slice containment.
 * A path outside any route group — a domain module, the middleware — answers
 * `undefined` and is judged on its own declarations.
 */
const SLICE_ROUTE_GROUP = /(?:^|\/)(apps\/api\/src\/slices\/[^/]+\/routes)(?:\.ts|\/)/;

function routeGroupOf(filePath: string): string | undefined {
  return SLICE_ROUTE_GROUP.exec(filePath)?.[1];
}

/**
 * One file in each form {@link SLICE_ROUTE_GROUP} recognises, so the pattern is
 * measured against the tree on every run rather than remembered. A layout the
 * repository no longer writes answers `undefined` for every module, which
 * narrows the marker scope back to one file per registration and takes a
 * slice's split routes out of the check — the silent direction the group scope
 * exists to close, and one no violation would report.
 */
const ROUTE_GROUP_WITNESSES = [
  'apps/api/src/slices/chat/routes.ts',
  'apps/api/src/slices/chat/routes/payer-seam.ts',
];

const LAYOUT_MOVED =
  'These are the two spellings the marker scope reads — a slice routes module, and a module under ' +
  'a slice routes directory. Point this rule at where the slices write their routes now, in the ' +
  'change that moves them.';

/**
 * The group declarations one specifier renames, under the name it gives them.
 * An import specifier and an export specifier answer the same two questions —
 * the name the other module uses, and the rename — so both are read here.
 */
function renamedBinding(
  specifier: ExportSpecifier | ImportSpecifier,
  declarations: readonly NamedDeclaration[]
): NamedDeclaration[] {
  const alias = specifier.getAliasNode()?.getText();
  if (alias === undefined) return [];
  const imported = specifier.getName();
  return declarations
    .filter((declaration) => declaration.name === imported)
    .map((declaration) => ({ name: alias, node: declaration.node }));
}

/**
 * The nodes a module itself publishes as its default export: a function
 * declaration carrying the default keyword, and the expression an
 * `export default` assigns — resolved one hop to the module's own declaration
 * when that expression is the name of one, since `export default
 * paidRunStartBody` puts the marker in the declaration rather than in the
 * statement.
 */
function declaredDefaults(module_: SourceFile): Node[] {
  const declared = module_.getFunctions().filter((function_) => function_.hasDefaultKeyword());
  const assigned = module_.getExportAssignments().flatMap((assignment) => {
    const expression = assignment.getExpression();
    const named = namedDeclarations(module_)
      .filter((declaration) => declaration.name === expression.getText())
      .map((declaration) => declaration.node);
    return named.length > 0 ? named : [expression];
  });
  return [...declared, ...assigned];
}

/**
 * What a module puts in its own default slot without forwarding another's: what
 * it declares there, and what an export statement of its own renames into it
 * (`export { paidRunStartBody as default };`).
 *
 * The statement is read here and the forward is not, which is what holds a
 * forward to one hop: a specifier-less export statement reaches no further
 * module, so a forward resolved through this can never follow a second one.
 */
function localDefaults(module_: SourceFile, declarations: readonly NamedDeclaration[]): Node[] {
  const renamed = module_
    .getExportDeclarations()
    .filter((exportDeclaration) => exportDeclaration.getModuleSpecifier() === undefined)
    .flatMap((exportDeclaration) =>
      exportDeclaration
        .getNamedExports()
        .flatMap((specifier) => renamedBinding(specifier, declarations))
    )
    .filter((binding) => binding.name === DEFAULT_EXPORT)
    .map((binding) => binding.node);
  return [...declaredDefaults(module_), ...renamed];
}

/**
 * A sibling's default slot, under each name an `export { default … } from`
 * gives it — `default` again when the forward keeps the name. The origin is
 * reached by its specifier because a default export carries no name to match,
 * and it is admitted only from the forwarding module's own group, which is
 * where every other reading here stops too.
 *
 * The origin's slot is read the way the origin fills it, not the narrower way a
 * declaration alone would: a module that renames a declaration into its own
 * default slot publishes through a barrel exactly as one declaring `export
 * default` does, and a forward that saw only the second would make where the
 * marker sits depend on which of two equivalent spellings the origin chose.
 */
function forwardedDefaults(
  exportDeclaration: ExportDeclaration,
  group: string | undefined,
  declarations: readonly NamedDeclaration[]
): NamedDeclaration[] {
  const names = exportDeclaration
    .getNamedExports()
    .filter((specifier) => specifier.getName() === DEFAULT_EXPORT)
    .map((specifier) => specifier.getAliasNode()?.getText() ?? DEFAULT_EXPORT);
  if (names.length === 0) return [];
  const target = exportDeclaration.getModuleSpecifierSourceFile();
  if (target === undefined || routeGroupOf(relativePath(target)) !== group) return [];
  return localDefaults(target, declarations).flatMap((node) =>
    names.map((name) => ({ name, node }))
  );
}

/**
 * The group declarations a module republishes under another name
 * (`export { paidRunStartBody as buildRunStartBody } from './run-body.js'`),
 * together with the sibling default slots it forwards. Both ends of a rename
 * sit inside the group — the module doing it is a group module, and the origin
 * is matched against the group's own declarations or resolved inside the same
 * group — so the re-export reaches no further than the name-only match does.
 *
 * One hop, not a fixed point: a chain of renames inside one slice's route group
 * would be a second module doing nothing but forwarding, and the group is small
 * enough that it has none. `dev-fixtures-unreachable-from-production.rule.ts`
 * is where the fixed point lives, because its surface crosses the whole tree.
 */
function reexportedGroupDeclarations(
  module_: SourceFile,
  declarations: readonly NamedDeclaration[]
): NamedDeclaration[] {
  const group = routeGroupOf(relativePath(module_));
  return module_
    .getExportDeclarations()
    .flatMap((exportDeclaration) => [
      ...exportDeclaration
        .getNamedExports()
        .flatMap((specifier) => renamedBinding(specifier, declarations)),
      ...forwardedDefaults(exportDeclaration, group, declarations),
    ]);
}

/**
 * Everything a module publishes in its default slot: what it declares there,
 * and what it republishes or forwards there from a group sibling.
 *
 * A default export publishes no name a handler could spell, so a route reaching
 * one is scoped only through the local name its importer chooses.
 */
function defaultPublications(
  module_: SourceFile,
  declarations: readonly NamedDeclaration[]
): Node[] {
  const republished = reexportedGroupDeclarations(module_, declarations)
    .filter((binding) => binding.name === DEFAULT_EXPORT)
    .map((binding) => binding.node);
  return [...declaredDefaults(module_), ...republished];
}

/**
 * The group's declarations under the LOCAL names this module binds them to: a
 * renamed named import, and either spelling of the default slot. Matched on the
 * name the EXPORTING module publishes, never on the local spelling, the way
 * `rate-limit-registries-publish-where-routes-count.rule.ts` reads an import
 * specifier: without it `import { paidRunStartBody as buildRunStartBody }`
 * leaves the handler spelling a name no module declares, and the route drops
 * out of the checked set silently — the one direction this rule may not fail
 * in.
 *
 * Read generously, as the name-only match is. A type-only specifier is bound
 * here too, because a binding only ever ENLARGES the checked set, and the same
 * directional argument that drops the binding requirement drops the
 * value-import requirement with it.
 */
function boundGroupDeclarations(
  sourceFile: SourceFile,
  group: string,
  declarations: readonly NamedDeclaration[]
): NamedDeclaration[] {
  return sourceFile.getImportDeclarations().flatMap((importDeclaration) => {
    const module_ = importDeclaration.getModuleSpecifierSourceFile();
    if (module_ === undefined || routeGroupOf(relativePath(module_)) !== group) return [];
    const byDefault = defaultPublications(module_, declarations).map((node) => ({
      name: DEFAULT_EXPORT,
      node,
    }));
    const renamed = importDeclaration
      .getNamedImports()
      .flatMap((specifier) => renamedBinding(specifier, [...declarations, ...byDefault]));
    const direct = importDeclaration.getDefaultImport()?.getText();
    if (direct === undefined) return renamed;
    return [...renamed, ...byDefault.map(({ node }) => ({ name: direct, node }))];
  });
}

/**
 * The declarations that may carry a route's paid marker: every named
 * declaration of the module's own route group, under the name its own module
 * gives it and under any local name this module binds it to, or its own alone
 * when it belongs to no group. A test module under the group declares no
 * shipped run body, so {@link isApiSourceFile} withholds it.
 */
function markerDeclarations(project: Project, sourceFile: SourceFile): NamedDeclaration[] {
  const group = routeGroupOf(relativePath(sourceFile));
  if (group === undefined) return namedDeclarations(sourceFile);
  const modules = project
    .getSourceFiles()
    .filter((module_) => isApiSourceFile(module_) && routeGroupOf(relativePath(module_)) === group);
  const declared = modules.flatMap((module_) => namedDeclarations(module_));
  const published = [
    ...declared,
    ...modules.flatMap((module_) => reexportedGroupDeclarations(module_, declared)),
  ];
  return [...published, ...boundGroupDeclarations(sourceFile, group, published)];
}

interface CallSite {
  readonly file: string;
  readonly line: number;
}

function payerFreezeCallSites(project: Project): CallSite[] {
  const sites: CallSite[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (!isApiSourceFile(sourceFile)) continue;
    const filePath = relativePath(sourceFile);
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (calleeName(call) !== PAYER_FREEZE) continue;
      sites.push({ file: filePath, line: call.getStartLineNumber() });
    }
  }
  return sites;
}

/** Whether the string literal is the paid discriminant, node or subtree. */
function carriesPaidLiteral(node: Node): boolean {
  if (Node.isStringLiteral(node)) return node.getLiteralText() === PAID_MODE;
  return node
    .getDescendantsOfKind(SyntaxKind.StringLiteral)
    .some((literal) => literal.getLiteralText() === PAID_MODE);
}

/**
 * Whether the node assigns the paid run mode: a `mode` property whose VALUE
 * carries the `'paid'` literal, at any depth of the assigned expression, so a
 * mode picked by a conditional stays in scope alongside a bare literal.
 *
 * A property ASSIGNMENT, never a property signature: `Extract<RunStartBody, {
 * mode: 'paid' }>` spells the same two tokens in a type position, and a run
 * mode is not declared by naming its type. And a value read structurally cannot
 * be spelled in a comment, which is what a raw-text read admitted — a scope
 * signal that only ever SUBTRACTS routes has to come off the AST
 * (`route-shapes.ts`'s directional rule).
 */
function declaresPaidMode(node: Node): boolean {
  return node
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .some(
      (property) =>
        property.getName() === RUN_MODE_PROPERTY &&
        carriesPaidLiteral(property.getInitializerOrThrow())
    );
}

function startsPaidRun(
  registration: RouteRegistration,
  declarations: NamedDeclaration[],
  handler: Node
): boolean {
  if (declaresPaidMode(handler)) return true;
  return referencesIdentifier(
    handler,
    declarationsWhere(declarations, declaresPaidMode, registration)
  );
}

function checkRegistration(
  registration: RouteRegistration,
  declarations: NamedDeclaration[],
  filePath: string
): ArchViolation | undefined {
  const handler = handlerNode(registration);
  if (handler === undefined) return undefined;
  if (!startsPaidRun(registration, declarations, handler)) return undefined;
  if (referencesIdentifier(handler, [SEAM])) return undefined;
  return {
    file: filePath,
    line: registration.line,
    message: `${registration.method.toUpperCase()} route '${registration.path}' starts a paid run without passing through ${SEAM} — every paid turn route resolves its payer at that seam, which is where the model-selection gates are applied.`,
  };
}

/** Clause one: a second caller of the payer freeze is a second bypass site. */
function checkSingleCallSite(project: Project): ArchViolation[] {
  const sites = payerFreezeCallSites(project);
  if (sites.length <= 1) return [];
  return sites.map((site) => ({
    file: site.file,
    line: site.line,
    message: `${PAYER_FREEZE} must keep exactly one call site — the payer-resolution seam ${SEAM} — and ${String(sites.length)} were found; a second caller is a second place the model-selection gates can be omitted.`,
  }));
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    assertNamedPathsExist(RULE, project, ROUTE_GROUP_WITNESSES, LAYOUT_MOVED);
    const violations: ArchViolation[] = checkSingleCallSite(project);

    for (const sourceFile of project.getSourceFiles()) {
      if (!isApiSourceFile(sourceFile)) continue;
      const filePath = relativePath(sourceFile);
      const declarations = markerDeclarations(project, sourceFile);
      for (const registration of routeRegistrations(sourceFile)) {
        const violation = checkRegistration(registration, declarations, filePath);
        if (violation !== undefined) violations.push(violation);
      }
    }
    return violations;
  },
};

export default rule;
