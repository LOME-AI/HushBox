import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import {
  assertNamedPathsExist,
  failWith,
  isRepoPath,
  relativePath,
  sourceFileAt,
} from '../lib/paths.js';
import type {
  CallExpression,
  ImportDeclaration,
  ObjectBindingPattern,
  ObjectLiteralExpression,
  Project,
  SourceFile,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A port request names a stack whose declaration says it binds host ports.
 *
 * The local stacks are laid out so that a stack declaring it binds nothing
 * takes its band after every stack that does, which is what lets such a stack
 * be added without renumbering a port some server is already listening on.
 * That safety result rests on the declaration alone: the plan allocates the
 * band either way, and a process that binds it is doing something the layout
 * assumed nobody does. This rule is what makes the declaration fail closed —
 * asking the plan for a port on a stack that binds none is refused where it is
 * written, rather than trusted not to happen.
 *
 * The forbidden set is READ from the declaration rather than written here, so
 * the gate cannot drift from the flag it enforces: flip a stack to binding and
 * requests for it stop being reported in the same edit, with nothing to keep in
 * agreement. That is also why this is an architecture rule and not a lint rule
 * — ESLint sees one file at a time and would have to carry its own copy of the
 * mode names, which is the drift this exists to prevent.
 *
 * What it does NOT see. The first three are the counts a request escapes on —
 * the stack it names, the way it reaches the allocator, and where the file sits
 * — and they are independent, so a mode written out in full is NOT on its own
 * enough to be caught. The last two are limits of the instrument itself:
 *
 * - A mode with no literal to read. Quoting does not decide it: a mode in
 *   quotes and a mode in backticks with nothing substituted are both read. What
 *   escapes is a mode the file never writes down — computed, read from the
 *   environment, taken off an imported value, or passed in as a parameter — and
 *   a template with a substitution in it is that rather than a written mode. A
 *   clause that only narrows the type of a written one — `as`, `satisfies` — is
 *   read through. The env-file generator is the computed shape, and
 *   legitimately so: it emits every stack's ports into that stack's env file,
 *   and it passes the mode through as a value.
 * - An allocator reached under a name this file never binds to it. The names
 *   read are what a static import binds (aliases and a whole-module namespace
 *   included) and what a dynamic import binds, destructured or whole, under
 *   either spelling of a written-out specifier. Out of reach: a dynamic import
 *   whose specifier the file computes instead of writing down — the
 *   `new URL(…, import.meta.url).href` form this repo uses where a relative
 *   specifier cannot carry its extension, which is a string at runtime and no
 *   literal here — and an allocator handed on to a further name or taken as a
 *   parameter, since resolution walks declarations rather than values.
 * - A file the architecture layer does not scan. The layer globs workspace
 *   source trees (`packages/config/arch/lib/source-scope.ts`), so tool config
 *   at the repository root or at a package root sits outside every rule here,
 *   this one included. It is the one thing a lint rule WOULD have caught that
 *   this does not — and only partly: ESLint lints root-level tool config, while
 *   the shared base exempts the package-root kind, so that half is read by
 *   neither gate.
 * - A listener. The rule stands over callers of the ALLOCATION, so a process
 *   that reads a port out of a generated env file and binds it is invisible
 *   here — the env file names every service's port for the stack it belongs to,
 *   whether that stack binds or not.
 * - A declaration with no non-binding stack in it. Every stack binding its own
 *   allocation leaves this rule nothing to report, which is correct rather than
 *   broken: there is no claim left to enforce. Its teeth are exactly the flag.
 */

/** The module that declares the stacks, their flags, and the allocators. */
export const PORT_PLAN_MODULE = 'scripts/lib/stack/port-plan.ts';

/**
 * The plan's own suite, which must be able to ask for a non-binding stack's
 * band: proving the bands disjoint means computing both sides of the
 * comparison. It is the one caller whose request is the invariant rather than a
 * breach of it.
 */
export const BAND_PROOF_MODULE = 'scripts/lib/stack/port-plan.test.ts';

/** The declared map of stack to what that stack is to the allocation. */
const DECLARATIONS = 'STACK_MODE_DECLARATIONS';

/** The flag inside one stack's declaration that this rule enforces. */
const BINDS_HOST_PORTS = 'bindsHostPorts';

/** The plan's allocating exports — the two ways a caller asks for a port. */
const ALLOCATORS: readonly string[] = ['portFor', 'portsFor'];

/** The property a request carries its stack in. */
const MODE_PROPERTY = 'mode';

/** The plan's module name, without the extension a specifier may spell either way. */
const PLAN_MODULE_NAME = path.posix.basename(PORT_PLAN_MODULE).replace(/\.ts$/, '');

/** True for a module specifier that names the plan. */
function namesThePlan(specifier: string): boolean {
  return path.posix.basename(specifier).replace(/\.[cm]?[jt]s$/, '') === PLAN_MODULE_NAME;
}

const RULE = 'port-requests-name-a-binding-stack';

const fail: (message: string) => never = failWith(RULE);

const MISSING_PATHS_REMEDY =
  'One names the declaration this rule reads its forbidden set from and the other the suite ' +
  'allowed to ask for a non-binding band; a rule that cannot find either enforces nothing ' +
  'while reporting success. Point this rule at their new paths in the change that moved them.';

function violationMessage(mode: string): string {
  return (
    `This asks the port plan for a port on the "${mode}" stack, which declares ` +
    `${BINDS_HOST_PORTS}: false. Its band is allocated after every band a stack listens on, ` +
    'and that ordering is what lets it exist without renumbering ports other stacks already ' +
    'bind — so a process listening here is outside what the layout assumes. Take the band of a ' +
    'stack that binds, or a kernel-assigned port (listen on 0) when the test only needs some ' +
    'listener. If this stack is meant to bind now, say so at its declaration in ' +
    `${PORT_PLAN_MODULE} and take the renumbering that follows.`
  );
}

/** One stack's entry in the declaration: which stack, and whether it binds. */
function declaredStack(property: Node): { mode: string; binds: boolean } | undefined {
  if (!Node.isPropertyAssignment(property)) return undefined;
  const stack = property.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
  const flag = stack?.getProperty(BINDS_HOST_PORTS);
  if (flag === undefined || !Node.isPropertyAssignment(flag)) return undefined;
  return {
    mode: property.getName().replaceAll(/^['"`]|['"`]$/g, ''),
    binds: flag.getInitializer()?.getKind() !== SyntaxKind.FalseKeyword,
  };
}

/** The stacks the declaration says bind none of what they are allocated. */
function nonBindingModes(plan: SourceFile): Set<string> {
  const declaration = plan.getVariableDeclaration(DECLARATIONS);
  const literal = declaration?.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
  if (literal === undefined) {
    fail(
      `${PORT_PLAN_MODULE} declares no object literal named ${DECLARATIONS}, so this rule has ` +
        'no set of stacks to refuse and would pass over every request ever written. Give it the ' +
        'declaration under its current name in the change that renamed or reshaped it.'
    );
  }

  const declared = literal
    .getProperties()
    .map((property) => declaredStack(property))
    .filter((entry) => entry !== undefined);
  if (declared.length === 0) {
    fail(
      `${DECLARATIONS} in ${PORT_PLAN_MODULE} carries no ${BINDS_HOST_PORTS} flag this rule can ` +
        'read, so its forbidden set is empty for a reason nobody chose. Restate the flag, or ' +
        'retire this rule with the claim it enforced.'
    );
  }
  return new Set(declared.filter((entry) => !entry.binds).map((entry) => entry.mode));
}

/** The plan still publishes the allocators this rule watches call sites of. */
function assertAllocatorsPublished(plan: SourceFile): void {
  for (const allocator of ALLOCATORS) {
    if (plan.getFunction(allocator)?.isExported() === true) continue;
    fail(
      `${PORT_PLAN_MODULE} no longer exports ${allocator}. This rule matches call sites by that ` +
        'name, so every search below comes back empty however many callers ask for a ' +
        'non-binding band through whatever replaced it. Give this rule the name the plan ' +
        'allocates under now, in the change that renamed it.'
    );
  }
}

/**
 * What one file calls the plan: the names standing for an allocator, and the
 * names standing for the module those allocators are reached through.
 *
 * Two sets rather than one because a call is written either way — `portFor(…)`
 * against a name bound to the function, or `plan.portFor(…)` against a name
 * bound to the module — and a gate that read only the first would pass over a
 * request whose stack is written out in full.
 */
interface PlanBindings {
  allocators: Set<string>;
  modules: Set<string>;
}

/** The allocator names one static import of the plan binds, aliases included. */
function importedAllocators(declaration: ImportDeclaration, into: PlanBindings): void {
  for (const named of declaration.getNamedImports()) {
    if (named.isTypeOnly() || !ALLOCATORS.includes(named.getName())) continue;
    into.allocators.add(named.getAliasNode()?.getText() ?? named.getName());
  }
}

/** The names a static import of the plan binds, aliases and namespaces included. */
function staticBindings(sourceFile: SourceFile, into: PlanBindings): void {
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    if (!namesThePlan(declaration.getModuleSpecifierValue())) continue;
    const namespace = declaration.getNamespaceImport();
    if (namespace !== undefined) into.modules.add(namespace.getText());
    importedAllocators(declaration, into);
  }
}

/** True when this initializer is a dynamic import naming the plan. */
function importsThePlanDynamically(node: Node | undefined): boolean {
  const call = unwrapped(node);
  if (!Node.isCallExpression(call)) return false;
  if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) return false;
  const specifier = asStringLiteral(call.getArguments()[0]);
  return specifier !== undefined && namesThePlan(specifier);
}

/** The allocator names one destructuring of the plan binds, renames included. */
function destructuredAllocators(pattern: ObjectBindingPattern, into: PlanBindings): void {
  for (const element of pattern.getElements()) {
    const exported = element.getPropertyNameNode()?.getText() ?? element.getName();
    if (ALLOCATORS.includes(exported)) into.allocators.add(element.getName());
  }
}

/** The names a dynamic import of the plan binds, destructured or whole. */
function dynamicBindings(sourceFile: SourceFile, into: PlanBindings): void {
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (!importsThePlanDynamically(declaration.getInitializer())) continue;
    const name = declaration.getNameNode();
    if (Node.isObjectBindingPattern(name)) {
      destructuredAllocators(name, into);
    } else {
      into.modules.add(name.getText());
    }
  }
}

/** Everything this file calls the plan and its allocators. */
function planBindings(sourceFile: SourceFile): PlanBindings {
  const bindings: PlanBindings = { allocators: new Set(), modules: new Set() };
  staticBindings(sourceFile, bindings);
  dynamicBindings(sourceFile, bindings);
  return bindings;
}

/** True when this call reaches one of the plan's allocators, however named. */
function isAllocatorCall(call: CallExpression, bindings: PlanBindings): boolean {
  const expression = call.getExpression();
  if (Node.isPropertyAccessExpression(expression)) {
    return (
      bindings.modules.has(expression.getExpression().getText()) &&
      ALLOCATORS.includes(expression.getName())
    );
  }
  return bindings.allocators.has(expression.getText());
}

/**
 * The one string a name stands for in this file, or nothing.
 *
 * A name two declarations in one file could supply is deliberately not
 * resolved: this walks declarations rather than scopes, so picking one of them
 * would be a guess, and a gate that guesses reports a caller for what a
 * neighbouring function wrote.
 */
function literalBoundTo(sourceFile: SourceFile, name: string): string | undefined {
  const declared = sourceFile
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((declaration) => declaration.getName() === name);
  if (declared.length !== 1) return undefined;
  return asStringLiteral(declared[0]?.getInitializer());
}

/**
 * The expression under whatever wraps it without changing what it stands for:
 * an `as` or `satisfies` clause, the parentheses one of those needs, and the
 * `await` a dynamic import is taken through.
 */
function unwrapped(node: Node | undefined): Node | undefined {
  let inner = node;
  while (
    Node.isAsExpression(inner) ||
    Node.isSatisfiesExpression(inner) ||
    Node.isParenthesizedExpression(inner) ||
    Node.isAwaitExpression(inner)
  ) {
    inner = inner.getExpression();
  }
  return inner;
}

/**
 * The text of a written-out string, through any clause that only narrows its
 * type. Both spellings of one count: quotes, and backticks with nothing
 * substituted into them.
 */
function asStringLiteral(node: Node | undefined): string | undefined {
  const inner = unwrapped(node);
  return Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner)
    ? inner.getLiteralValue()
    : undefined;
}

/** The stack an object literal names, when it writes one out. */
function modeNamed(request: ObjectLiteralExpression, sourceFile: SourceFile): string | undefined {
  const property = request.getProperty(MODE_PROPERTY);
  if (Node.isShorthandPropertyAssignment(property)) {
    return literalBoundTo(sourceFile, MODE_PROPERTY);
  }
  if (!Node.isPropertyAssignment(property)) return undefined;
  const written = property.getInitializer();
  return Node.isIdentifier(written)
    ? literalBoundTo(sourceFile, written.getText())
    : asStringLiteral(written);
}

/** The request objects one call hands the allocator, hoisted ones included. */
function requestsOf(
  args: readonly Node[],
  sourceFile: SourceFile
): readonly ObjectLiteralExpression[] {
  return args.flatMap((argument) => {
    if (Node.isObjectLiteralExpression(argument)) return [argument];
    if (!Node.isIdentifier(argument)) return [];
    const declared = sourceFile
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .filter((declaration) => declaration.getName() === argument.getText());
    if (declared.length !== 1) return [];
    const inner = unwrapped(declared[0]?.getInitializer());
    return Node.isObjectLiteralExpression(inner) ? [inner] : [];
  });
}

function requestsNamingANonBindingStack(
  sourceFile: SourceFile,
  forbidden: ReadonlySet<string>
): ArchViolation[] {
  const bindings = planBindings(sourceFile);
  if (bindings.allocators.size === 0 && bindings.modules.size === 0) return [];

  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => isAllocatorCall(call, bindings))
    .flatMap((call) => {
      const named = requestsOf(call.getArguments(), sourceFile)
        .map((request) => modeNamed(request, sourceFile))
        .filter((mode): mode is string => mode !== undefined && forbidden.has(mode));
      return named.map((mode) => ({
        file: sourceFile.getFilePath(),
        line: call.getStartLineNumber(),
        message: violationMessage(mode),
      }));
    });
}

const EXEMPT: readonly string[] = [PORT_PLAN_MODULE, BAND_PROOF_MODULE];

function isInScope(sourceFile: SourceFile): boolean {
  const filePath = relativePath(sourceFile);
  return !EXEMPT.some((exempt) => isRepoPath(filePath, exempt));
}

const rule: ArchRule = {
  name: RULE,
  check(project: Project) {
    assertNamedPathsExist(RULE, project, EXEMPT, MISSING_PATHS_REMEDY);
    const plan = sourceFileAt(project, PORT_PLAN_MODULE);
    /* v8 ignore next -- assertNamedPathsExist already threw when the plan names no file */
    if (plan === undefined) return [];
    assertAllocatorsPublished(plan);
    const forbidden = nonBindingModes(plan);

    return project
      .getSourceFiles()
      .filter((sourceFile) => isInScope(sourceFile))
      .flatMap((sourceFile) => requestsNamingANonBindingStack(sourceFile, forbidden));
  },
};

export default rule;
