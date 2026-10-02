import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile, relativePath } from '../lib/paths.js';
import { REPO_ROOT, discoverSourceTrees, workspaceSourceTree } from '../lib/source-scope.js';
import type {
  ArrowFunction,
  CallExpression,
  FunctionExpression,
  Node as TsNode,
  Project,
  SourceFile,
  Symbol as TsSymbol,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * An entry point a developer can type at reads its command line before it does
 * anything else, and the line it reads is the grammar the entry itself
 * declares.
 *
 * WHY THIS IS A RULE RATHER THAN A TEST. The property was held by executing
 * every entry point as a real process and asserting what it printed. That
 * reach is what caught the mis-wirings, and its cost is that the driven set
 * contains commands that end processes and recreate infrastructure: they are
 * harmless to run only while the wiring holds, so the suite performs the
 * destructive act on exactly the day the thing it guards breaks. Read
 * structurally, the same property costs nothing and cannot act.
 *
 * WHAT "READS IT FIRST" MEANS HERE. Statement order alone does not express it —
 * the guard bodies in this tree hand their work to a wrapper, to an immediately
 * invoked function, or to a `main` of their own module, and the read sits one
 * or two frames down. So the walk follows execution rather than lines: into a
 * guard's condition, into the callback a wrapper is handed, into a function of
 * the same module a call names, and never into a function that is merely
 * BUILT — a callback stored in a dependency object runs after the parse, not
 * before it. The wrapper is recognised by the symbol it resolves to, never by
 * the directory that symbol lives in. Over that order the rule asserts two
 * things:
 *
 * - nothing that can act runs before the first call into the shared grammar,
 *   where "can act" is everything the walk does not recognise as inert. The
 *   inert forms are the path, url and process-state reads an entry legitimately
 *   computes before it knows what it was asked to do; anything else — a call
 *   into another module, a construction, a spawn — is refused. Default-deny is
 *   the point: a new way to act is caught by not being on the list.
 * - the entry passes its OWN declared specification to the grammar. An entry
 *   that reads some other command's grammar answers for a line it does not
 *   have.
 *
 * WHY THE POPULATION IS RESOLVED, NOT SEARCHED. An entry point's grammar need
 * not be written in the entry: one declares its literal in a different module
 * under a non-standard name and re-exports it from the entry under the standard
 * one. No text search recovers the pair — a search for the literal names a
 * module that is not an entry point, a search for the standard name beside a
 * literal names neither module, and a search for the bare name names an entry
 * whose specification is not in it. So the population comes off the module
 * graph: every module holding a main guard, paired with whichever of its
 * exports RESOLVES to a command specification, alias hops included. A rename
 * cannot shrink it.
 *
 * WHAT THIS DOES NOT CATCH. It reads the shape of the wiring, never the
 * behaviour of the parse: a grammar that accepts a flag it should refuse
 * satisfies this rule, and the specification-level assertions in the scripts
 * package are what hold that. A module with no main guard is out of scope
 * however much argv it reads, because nothing types it.
 */

/** The workspace whose entry points a developer types at. */
const SCRIPTS_WORKSPACE = 'scripts';

const SCRIPTS_SOURCE_TREE = workspaceSourceTree(discoverSourceTrees(REPO_ROOT), SCRIPTS_WORKSPACE);

/** The module whose exports ARE the shared argument grammar. */
const GRAMMAR_MODULE = `${SCRIPTS_SOURCE_TREE}lib/cli/command-line.ts`;

/** How the main guard's test is spelled, wherever it is spelled. */
const MAIN_MODULE_TEST = 'isMainModule';

/** What one symbol of the shared plumbing does to a walk that reaches it. */
type PlumbingKind =
  /** Runs a function its caller handed it, so the walk follows it into that frame. */
  | 'runs-its-callers-frame'
  /** Answers a question about the process, reading only; it does not act. */
  | 'reads-only';

/** One symbol an entry point is legitimately wired through. */
interface Plumbing {
  readonly module: string;
  readonly name: string;
  readonly kind: PlumbingKind;
}

/**
 * The shared plumbing, named symbol by symbol.
 *
 * An address is not evidence. `lib/cli/` also holds modules that shell out to
 * git, so exempting the directory would pass a module for where it sits rather
 * than for what it does, and would extend that pass to whatever is added there
 * next. Each symbol below is one somebody read: it either runs a frame its
 * caller supplied, or it reads to compute an answer without acting on it.
 * Everything else in that tree is refused like any other call.
 */
const PLUMBING: readonly Plumbing[] = [
  {
    module: `${SCRIPTS_SOURCE_TREE}lib/cli/run-main.ts`,
    name: 'runMain',
    kind: 'runs-its-callers-frame',
  },
  {
    module: `${SCRIPTS_SOURCE_TREE}lib/cli/is-main.ts`,
    name: MAIN_MODULE_TEST,
    kind: 'reads-only',
  },
];

/**
 * The properties a command specification carries. Read off the resolved type
 * rather than the literal, so an alias, a re-export and a `satisfies` clause
 * all answer the same way.
 */
const SPEC_PROPERTIES: readonly string[] = ['command', 'summary', 'flags', 'positionals'];

/**
 * The process state an entry may read before it knows what it was asked to do.
 * Reads only: none of these leaves the process or changes anything, and an
 * entry computing its own location or its raw argv has not yet acted.
 */
const INERT_PROCESS_READS: readonly string[] = [
  'process.argv',
  'process.cwd',
  'process.env',
  'process.platform',
];

/** Node modules whose exports compute paths and nothing else. */
const INERT_NODE_MODULES = new Set(['node:path', 'node:url']);

/** What one call the walk reached turns out to be. */
type CallKind =
  /** A call into the shared grammar — the read this rule is looking for. */
  | { readonly kind: 'grammar'; readonly readsOwnSpec: boolean }
  /** Plumbing the entry is wired through, and the frames it hands work to. */
  | { readonly kind: 'transparent'; readonly enter: readonly TsNode[] }
  /** A frame of this module's own, entered where the call names it. */
  | { readonly kind: 'local'; readonly enter: readonly TsNode[] }
  /** A path, url or process-state read: not yet acting. */
  | { readonly kind: 'inert' }
  /** Everything else, which is where acting before the parse shows up. */
  | { readonly kind: 'acts'; readonly what: string };

/** The declaration a name lands on once alias hops are followed. */
function resolvedDeclaration(symbol: TsSymbol | undefined): TsNode | undefined {
  if (symbol === undefined) return undefined;
  const target = symbol.getAliasedSymbol() ?? symbol;
  return target.getDeclarations()[0];
}

/** The declaration an identifier names, alias hops followed. */
function declarationOf(node: TsNode): TsNode | undefined {
  return resolvedDeclaration(node.getSymbol());
}

/**
 * The declaration a specification name lands on, following the initializer
 * chain a re-export under another name creates. `export const COMMAND_LINE =
 * DAEMON_GRAMMAR` lands on the literal in the module that declared it, which is
 * the only place the pair is visible at all.
 */
function landedDeclaration(declaration: TsNode): TsNode {
  const seen = new Set<TsNode>();
  let current = declaration;
  while (Node.isVariableDeclaration(current) && !seen.has(current)) {
    seen.add(current);
    const initializer = current.getInitializer();
    if (initializer === undefined || !Node.isIdentifier(initializer)) return current;
    const next = declarationOf(initializer);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/** Whether a resolved declaration's type is a command specification. */
function isCommandSpecification(declaration: TsNode): boolean {
  const type = declaration.getType();
  return SPEC_PROPERTIES.every((property) => type.getProperty(property) !== undefined);
}

/** The specification an entry point declares, as the entry spells it. */
interface DeclaredSpec {
  /** The exported name, for the violation message. */
  readonly name: string;
  /** The declaration the name lands on — the identity a read is matched against. */
  readonly landed: TsNode;
}

/**
 * The specifications a module exports, each resolved to the declaration it
 * lands on. More than one is legal; the entry must read at least one of them.
 */
function declaredSpecs(sourceFile: SourceFile): DeclaredSpec[] {
  const specs: DeclaredSpec[] = [];
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      const landed = landedDeclaration(declaration);
      if (isCommandSpecification(landed)) specs.push({ name, landed });
    }
  }
  return specs;
}

/** The local names an import declaration binds, keyed to its module specifier. */
function importedModuleOf(sourceFile: SourceFile, name: string): string | undefined {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const bound =
      declaration.getDefaultImport()?.getText() === name ||
      declaration
        .getNamedImports()
        .some((element) => (element.getAliasNode() ?? element.getNameNode()).getText() === name) ||
      declaration.getNamespaceImport()?.getText() === name;
    if (bound) return declaration.getModuleSpecifierValue();
  }
  return undefined;
}

/** The leftmost identifier of a callee expression: `path` in `path.resolve`. */
function rootIdentifier(expression: TsNode): TsNode | undefined {
  let current = expression;
  while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
    current = current.getExpression();
  }
  return Node.isIdentifier(current) ? current : undefined;
}

/** Whether a callee only reads paths or process state. */
function isInertCallee(sourceFile: SourceFile, callee: TsNode): boolean {
  const text = callee.getText();
  if (INERT_PROCESS_READS.some((read) => text === read || text.startsWith(`${read}.`))) return true;
  const root = rootIdentifier(callee);
  if (root === undefined) return false;
  const module = importedModuleOf(sourceFile, root.getText());
  return module !== undefined && INERT_NODE_MODULES.has(module);
}

/** The name a resolved declaration carries, whichever way it is written. */
function declaredName(declaration: TsNode): string | undefined {
  return Node.isFunctionDeclaration(declaration) || Node.isVariableDeclaration(declaration)
    ? declaration.getName()
    : undefined;
}

/** Which piece of shared plumbing a resolved declaration is, when it is one. */
function plumbingFor(declaration: TsNode, declarationFile: string): Plumbing | undefined {
  const name = declaredName(declaration);
  if (name === undefined) return undefined;
  return PLUMBING.find((symbol) => symbol.name === name && declarationFile.endsWith(symbol.module));
}

/** Whether a node is written as a function with a body of its own. */
function isFunctionLiteral(node: TsNode): node is ArrowFunction | FunctionExpression {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node);
}

/** The body of a function-shaped declaration, whichever way it was written. */
function functionBodyOf(declaration: TsNode): TsNode | undefined {
  if (Node.isFunctionDeclaration(declaration)) return declaration.getBody();
  if (!Node.isVariableDeclaration(declaration)) return undefined;
  const initializer = declaration.getInitializer();
  if (initializer === undefined || !isFunctionLiteral(initializer)) return undefined;
  return initializer.getBody();
}

/** The body one argument hands a wrapper to run, written inline or by name. */
function invokedBodyOf(argument: TsNode, entry: SourceFile): TsNode | undefined {
  if (isFunctionLiteral(argument)) return argument.getBody();
  if (!Node.isIdentifier(argument)) return undefined;
  const declaration = declarationOf(argument);
  if (declaration?.getSourceFile() !== entry) return undefined;
  return functionBodyOf(declaration);
}

/** The bodies of the function-shaped arguments a wrapper invokes for its caller. */
function invokedArguments(call: CallExpression, entry: SourceFile): TsNode[] {
  return call
    .getArguments()
    .map((argument) => invokedBodyOf(argument, entry))
    .filter((body): body is TsNode => body !== undefined);
}

/** Whether one of a call's arguments names the entry's own specification. */
function passesOwnSpec(call: CallExpression, specs: readonly DeclaredSpec[]): boolean {
  return call.getArguments().some((argument) => {
    const named = Node.isAsExpression(argument) ? argument.getExpression() : argument;
    if (!Node.isIdentifier(named)) return false;
    const declaration = declarationOf(named);
    if (declaration === undefined) return false;
    const landed = landedDeclaration(declaration);
    return specs.some((spec) => spec.landed === landed);
  });
}

/** The body an immediately invoked function expression runs, parentheses and all. */
function immediateBodyOf(callee: TsNode): TsNode | undefined {
  const inner = Node.isParenthesizedExpression(callee) ? callee.getExpression() : callee;
  return isFunctionLiteral(inner) ? inner.getBody() : undefined;
}

/** What a call into a module other than this one is, by the symbol it resolves to. */
function classifyByDeclaration(
  call: CallExpression,
  callee: TsNode,
  entry: SourceFile,
  specs: readonly DeclaredSpec[]
): CallKind | undefined {
  const declaration = declarationOf(callee);
  if (declaration === undefined) return undefined;
  const declarationFile = relativePath(declaration.getSourceFile());
  if (declarationFile.endsWith(GRAMMAR_MODULE)) {
    return { kind: 'grammar', readsOwnSpec: passesOwnSpec(call, specs) };
  }
  const plumbing = plumbingFor(declaration, declarationFile);
  if (plumbing === undefined) return undefined;
  return plumbing.kind === 'runs-its-callers-frame'
    ? { kind: 'transparent', enter: invokedArguments(call, entry) }
    : { kind: 'inert' };
}

/** What a call expression is, from the walking entry point's side. */
function classify(
  call: CallExpression,
  entry: SourceFile,
  specs: readonly DeclaredSpec[]
): CallKind {
  const callee = call.getExpression();
  const immediate = immediateBodyOf(callee);
  if (immediate !== undefined) return { kind: 'transparent', enter: [immediate] };
  const byDeclaration = classifyByDeclaration(call, callee, entry, specs);
  if (byDeclaration !== undefined) return byDeclaration;
  if (isInertCallee(entry, callee)) return { kind: 'inert' };
  const declaration = declarationOf(callee);
  if (declaration?.getSourceFile() === entry) {
    const body = functionBodyOf(declaration);
    return { kind: 'local', enter: body === undefined ? [] : [body] };
  }
  return { kind: 'acts', what: callee.getText() };
}

/** What the walk found, in the order the process would reach it. */
interface Reached {
  /** The first thing that acts, when it ran before any grammar call. */
  readonly actedFirst: { readonly what: string; readonly line: number } | undefined;
  readonly readOwnSpec: boolean;
}

/** Nodes a walk never enters: a function built here runs later, or elsewhere. */
function isDeferred(node: TsNode): boolean {
  return (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isClassExpression(node)
  );
}

/**
 * Walks one guard in execution order, entering only the frames the process
 * would enter, and stops as soon as both questions are answered: whether
 * anything acted before the first grammar call, and whether the entry's own
 * specification reached the grammar.
 */
class GuardWalk {
  private acted: { readonly what: string; readonly line: number } | undefined;
  private grammar = false;
  private ownSpec = false;
  private readonly entered = new Set<TsNode>();

  constructor(
    private readonly entry: SourceFile,
    private readonly specs: readonly DeclaredSpec[]
  ) {}

  result(): Reached {
    return { actedFirst: this.acted, readOwnSpec: this.ownSpec };
  }

  private settled(): boolean {
    return this.acted !== undefined || this.ownSpec;
  }

  /**
   * `blame` is the call the ENTRY made, carried down into the frames it leads
   * to: a guard that calls a `main` of its own is reported against `main`, not
   * against whichever line inside it turned out to act first.
   */
  walk(node: TsNode, blame?: string): void {
    if (this.settled()) return;
    if (isDeferred(node)) return;
    if (Node.isNewExpression(node)) {
      if (this.walkArguments(node.getArguments(), blame)) return;
      this.act(blame ?? node.getExpression().getText(), node);
      return;
    }
    if (Node.isCallExpression(node)) {
      if (this.walkArguments(node.getArguments(), blame)) return;
      this.record(classify(node, this.entry, this.specs), node, blame);
      return;
    }
    for (const child of node.getChildren()) this.walk(child, blame);
  }

  /** Walks a call's arguments, which run before it does. True when that settled it. */
  private walkArguments(argumentsGiven: readonly TsNode[], blame: string | undefined): boolean {
    for (const argument of argumentsGiven) {
      this.walk(argument, blame);
      if (this.settled()) return true;
    }
    return false;
  }

  private act(what: string, at: TsNode): void {
    if (!this.grammar) this.acted = { what, line: at.getStartLineNumber() };
  }

  private record(classification: CallKind, call: CallExpression, blame: string | undefined): void {
    switch (classification.kind) {
      case 'grammar': {
        this.grammar = true;
        if (classification.readsOwnSpec) this.ownSpec = true;
        return;
      }
      case 'acts': {
        this.act(blame ?? classification.what, call);
        return;
      }
      case 'inert': {
        return;
      }
      case 'local': {
        this.enterFrames(classification.enter, blame ?? call.getExpression().getText());
        return;
      }
      default: {
        this.enterFrames(classification.enter, blame);
      }
    }
  }

  private enterFrames(frames: readonly TsNode[], blame: string | undefined): void {
    for (const frame of frames) {
      if (this.entered.has(frame)) continue;
      this.entered.add(frame);
      this.walk(frame, blame);
      if (this.settled()) return;
    }
  }
}

/**
 * The `if` statements that run only when this module is the process's entry
 * point, whether the test is written into the condition or bound to a name
 * first.
 */
function mainGuards(sourceFile: SourceFile): TsNode[] {
  const direct: TsNode[] = [];
  const gates: TsNode[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== MAIN_MODULE_TEST) continue;
    const guard = call.getFirstAncestor((ancestor) => Node.isIfStatement(ancestor));
    if (guard === undefined) {
      const bound = call.getFirstAncestor((ancestor) => Node.isVariableDeclaration(ancestor));
      if (bound !== undefined) gates.push(bound);
    } else if (!direct.includes(guard)) {
      direct.push(guard);
    }
  }
  return [...direct, ...gatedGuards(sourceFile, gates, direct)];
}

/** The identifiers one condition tests, whether it is one name or an expression. */
function conditionNames(condition: TsNode): TsNode[] {
  return Node.isIdentifier(condition)
    ? [condition]
    : condition.getDescendantsOfKind(SyntaxKind.Identifier);
}

/** The `if` statements testing a name the main-module test was bound to. */
function gatedGuards(
  sourceFile: SourceFile,
  gates: readonly TsNode[],
  already: readonly TsNode[]
): TsNode[] {
  if (gates.length === 0) return [];
  return sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement).filter(
    (statement) =>
      !already.includes(statement) &&
      conditionNames(statement.getExpression()).some((name) => {
        const declaration = declarationOf(name);
        return declaration !== undefined && gates.includes(declaration);
      })
  );
}

/**
 * A scanned file sits inside a repo-relative tree, however the project is
 * rooted: the runner builds its project at absolute paths and a rule's own
 * fixtures build theirs at the repo-relative ones, and a prefix test alone
 * silently reads the first as empty.
 */
function isInTree(filePath: string, tree: string): boolean {
  return filePath.startsWith(tree) || filePath.includes(`/${tree}`);
}

function isInScope(sourceFile: SourceFile): boolean {
  const filePath = relativePath(sourceFile);
  return isInTree(filePath, SCRIPTS_SOURCE_TREE) && !isTestFile(filePath);
}

function violationsFor(sourceFile: SourceFile): ArchViolation[] {
  const guards = mainGuards(sourceFile);
  if (guards.length === 0) return [];
  const specs = declaredSpecs(sourceFile);
  if (specs.length === 0) return [];
  const file = relativePath(sourceFile);
  const names = specs.map((spec) => spec.name).join(', ');
  const violations: ArchViolation[] = [];
  for (const guard of guards) {
    const walk = new GuardWalk(sourceFile, specs);
    walk.walk(guard);
    const reached = walk.result();
    if (reached.actedFirst !== undefined) {
      violations.push({
        file,
        line: reached.actedFirst.line,
        message:
          `this entry point calls \`${reached.actedFirst.what}\` before it reads the command ` +
          `line it declares (${names}). An entry acts only on a line its own grammar has ` +
          'accepted, so a token the grammar does not name is refused while the command is ' +
          'still nothing but a parse.',
      });
      continue;
    }
    if (!reached.readOwnSpec) {
      violations.push({
        file,
        line: guard.getStartLineNumber(),
        message:
          `this entry point declares a command line (${names}) that its main guard never ` +
          'reads, so every argument a developer types at it is dropped in silence — a help ' +
          'flag and a misspelt real flag alike run the pipeline instead.',
      });
    }
  }
  return violations;
}

const rule: ArchRule = {
  name: 'entry-points-read-their-command-line-first',
  check(project: Project): ArchViolation[] {
    return project
      .getSourceFiles()
      .filter((sourceFile) => isInScope(sourceFile))
      .flatMap((sourceFile) => violationsFor(sourceFile));
  },
};

export default rule;
