import path from 'node:path';
import { ts } from 'ts-morph';
import { failWith } from '../lib/paths.js';
import { REPO_ROOT, SCANNED_WORKSPACES } from '../lib/source-scope.js';
import type { FileSystemHost } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every environment key a dev server reads is one the `dev` task passes
 * through.
 *
 * WHY NOTHING ELSE CATCHES THIS. The task runner runs `dev` in strict
 * environment mode, so it strips every variable the task's pass-through list
 * does not name. A server that begins reading a key nobody added to that list
 * starts with the variable unset and fails to come up — while test, typecheck
 * and lint all pass, because none of them inspects the thing that is wrong. The
 * two end-to-end web-server entries that do start real dev servers invoke the
 * package script through the package manager rather than through the task
 * runner, so neither applies the list at all; only the full dev command runs the
 * task under it, and no gate runs that command.
 *
 * THE DIRECTION MATTERS, and it is why a test mirroring the list would not have
 * caught the defect this rule stands over: the code began reading something the
 * manifest did not pass, rather than the manifest losing something the code
 * already read. A mirror test compares the list against itself and stays green
 * through the first of those.
 *
 * WHAT THE WALK READS. The keys are read in the entry points themselves and in
 * the modules those entries call, never in the shared environment loader, which
 * names no individual key. So the walk starts at the file each `dev` script
 * executes and follows calls into first-party source, stopping at installed
 * dependencies — which is what keeps it from collecting the whole import
 * closure, where modules reached only by being imported carry reads no dev
 * server performs.
 *
 * A FUNCTION IS A FRAME, entered where a call names it. The file a `dev` script
 * executes is walked whole, inline callbacks included, because it IS the
 * server's own code; a named function of any module is entered where a call
 * reaches it, carrying that call site's arguments so a key named by a parameter
 * resolves to what the caller passed. A function handed on as a bare value is
 * entered too, with its parameters unbound — a hook registered rather than
 * called still runs. The set of frames already entered is what terminates the
 * walk: a frame is keyed by its declaration, its tainted parameters and the
 * argument text of the call that entered it, all of which come from the source,
 * so the keys are finite however deeply the call graph recurses.
 *
 * THREE SHAPES A KEY IS WRITTEN IN. A literal; a first-party string constant,
 * resolved through the module that declares it; and a name ASSEMBLED at runtime,
 * of which the walk reads the static prefix every product must begin with. The
 * third is not a form to skip: a live dev path builds its port variable by
 * template literal, and both skipping the site and reporting it unresolvable
 * would be wrong — the first leaves a real hole, the second fires on a healthy
 * tree. A prefix is covered only by a wildcard the prefix itself starts with,
 * so it can never launder a key past a literal pattern.
 *
 * WHAT THIS DOES NOT PROVE. It reads which keys are READ, never what a server
 * does without one: a read whose absence the code tolerates is reported exactly
 * like one that fails the start, because no syntax tells them apart. A call
 * through a namespace import (`import * as m` then `m.start(process.env)`) is a
 * member call on a namespace object, which the walk does not follow, so reads
 * behind one are invisible to it. And a value that reaches the environment
 * through a form the walk does not recognise — a key with no static prefix, a
 * module specifier it cannot resolve, a `dev` script shape it cannot read — is
 * REPORTED rather than passed over, because a walk that silently drops a subtree
 * reads as a clean pass.
 */

const RULE_NAME = 'dev-servers-read-passed-through-env';

const fail = failWith(RULE_NAME);

/** The task manifest declaring what each task's environment carries. */
const TASK_MANIFEST = 'turbo.json';

/** The task whose pass-through list every dev server's reads are held to. */
const DEV_TASK = 'dev';

/**
 * The first-party config file a dev runner evaluates, per runner binary. A
 * runner is an installed dependency the walk stops at, but the config it loads
 * is this repository's own code and is where such a server reads its ports.
 */
const RUNNER_CONFIGS: Readonly<Record<string, string>> = {
  vite: 'vite.config.ts',
  astro: 'astro.config.mjs',
};

/** Commands that re-enter the same manifest under another script's name. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'run']);

/** Extensions a script token carries when it names a file to execute. */
const EXECUTABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mjs'];

/**
 * The shell operators that end one command and start the next. Longest first,
 * so a conjunction is never read as two backgrounding operators.
 */
const COMMAND_SEPARATOR = /\s*(?:&&|\|\||;|\||&)\s*/;

/**
 * How deep a key expression is chased. Unlike a frame, a key expression has no
 * visited set to terminate it — two module constants can name each other — so
 * the depth is what ends that chase, and a key it stops on is reported
 * unresolvable like any other name the walk cannot read.
 */
const KEY_DEPTH = 12;

/** What one environment key expression turned out to name. */
type EnvKey =
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'unresolved'; readonly text: string };

/** One thing the walk found, at the position it was written. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly key: EnvKey | undefined;
  readonly specifier: string | undefined;
}

/** What a module specifier resolved to, or why it did not. */
type Resolution =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'missing' };

interface Manifest {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
}

/** A parameter's binding: the expression a call site passed, and that site's frame. */
interface Bound {
  readonly node: ts.Node;
  readonly frame: Frame;
}

/** One function's body as the walk sees it, with what its caller supplied. */
interface Frame {
  readonly file: string;
  readonly source: ts.SourceFile;
  /** The node the frame's code sits in, which is what a closure is judged against. */
  readonly body: ts.Node;
  readonly bindings: ReadonlyMap<string, Bound>;
  readonly tainted: ReadonlySet<string>;
}

/** One `package.json` glob per declared workspace pattern. */
function manifestGlobs(repoRoot: string): string[] {
  return SCANNED_WORKSPACES.map((pattern) => path.join(repoRoot, pattern, 'package.json'));
}

function readManifest(fileSystem: FileSystemHost, manifestPath: string): Manifest {
  return JSON.parse(fileSystem.readFileSync(manifestPath)) as Manifest;
}

/** The strings in a parsed list, which is the shape every pattern list carries. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * The environment patterns a `dev` task's server is started with: the task's own
 * pass-through list plus the global list every task carries. Read through the
 * TypeScript configuration parser because the manifest is JSON with comments,
 * which `JSON.parse` refuses.
 */
function passedThroughPatterns(fileSystem: FileSystemHost, repoRoot: string): string[] {
  const manifestPath = path.join(repoRoot, TASK_MANIFEST);
  if (!fileSystem.fileExistsSync(manifestPath)) {
    fail(
      `'${TASK_MANIFEST}' names no file, so nothing states which environment the \`${DEV_TASK}\` ` +
        'task passes through and no dev server can be held to it.'
    );
  }
  // The parser yields an object or an error and never neither, so a manifest
  // that does not parse reads as an empty one — which would pass every server
  // for naming no pattern at all. The error is what stops that.
  const result = ts.parseConfigFileTextToJson(manifestPath, fileSystem.readFileSync(manifestPath));
  if (result.error !== undefined) {
    fail(
      `'${TASK_MANIFEST}' did not parse: ${ts.flattenDiagnosticMessageText(result.error.messageText, ' ')}`
    );
  }
  const parsed: unknown = result.config;
  const manifest = parsed as { globalEnv?: unknown; tasks?: Record<string, unknown> };
  const task: unknown = manifest.tasks?.[DEV_TASK];
  const taskEnv =
    typeof task === 'object' && task !== null
      ? (task as { passThroughEnv?: unknown }).passThroughEnv
      : undefined;
  return [...stringList(manifest.globalEnv), ...stringList(taskEnv)];
}

/** Whether one pattern names a key exactly, or covers it by trailing wildcard. */
function patternCovers(pattern: string, key: string): boolean {
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
}

/**
 * Whether every key a static prefix can produce is covered. Only a wildcard the
 * prefix itself starts with does that: a literal pattern names one key, and a
 * wildcard longer than the prefix leaves products outside it.
 */
function patternsCoverPrefix(patterns: readonly string[], prefix: string): boolean {
  return patterns.some(
    (pattern) => pattern.endsWith('*') && prefix.startsWith(pattern.slice(0, -1))
  );
}

/** The parse kind an extension implies; JSX is legal syntax in one of them. */
function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('x')) return ts.ScriptKind.TSX;
  return filePath.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * The repository as this rule reads it: its file system, and what it has parsed.
 * Parsing is also how the rule asks whether a file is there, so one answer
 * serves both questions and no path can exist for one and not the other.
 */
class Repository {
  private readonly parsed = new Map<string, ts.SourceFile | undefined>();
  private readonly packageDirs = new Map<string, string>();

  constructor(
    private readonly fileSystem: FileSystemHost,
    readonly root: string
  ) {
    for (const manifestPath of fileSystem.globSync(manifestGlobs(root))) {
      const name = readManifest(fileSystem, manifestPath).name;
      if (name !== undefined) this.packageDirs.set(name, path.dirname(manifestPath));
    }
  }

  relative(filePath: string): string {
    return path.relative(this.root, filePath);
  }

  parse(filePath: string): ts.SourceFile | undefined {
    if (this.parsed.has(filePath)) return this.parsed.get(filePath);
    const source = this.fileSystem.fileExistsSync(filePath)
      ? ts.createSourceFile(
          filePath,
          this.fileSystem.readFileSync(filePath),
          ts.ScriptTarget.Latest,
          true,
          scriptKindFor(filePath)
        )
      : undefined;
    this.parsed.set(filePath, source);
    return source;
  }

  /** The first candidate path that parses, which is what a specifier resolves to. */
  private existing(base: string): string | undefined {
    const candidates = [
      base,
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.js$/, '.tsx'),
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mjs`,
      path.join(base, 'index.ts'),
    ];
    return candidates.find((candidate) => this.parse(candidate) !== undefined);
  }

  /**
   * The file a module specifier names: a repo-local path, or a workspace
   * package's own declared entry for the subpath. A specifier naming neither is
   * an installed dependency, where the walk stops.
   */
  resolve(specifier: string, fromFile: string): Resolution {
    if (specifier.startsWith('.')) {
      return found(this.existing(path.resolve(path.dirname(fromFile), specifier)));
    }
    const packageDir = [...this.packageDirs.entries()].find(
      ([name]) => specifier === name || specifier.startsWith(`${name}/`)
    );
    if (packageDir === undefined) return { kind: 'external' };
    const [name, directory] = packageDir;
    const subpath = specifier.slice(name.length);
    const exported = readManifest(this.fileSystem, path.join(directory, 'package.json')).exports?.[
      subpath === '' ? '.' : `.${subpath}`
    ];
    if (typeof exported === 'string') return found(this.existing(path.join(directory, exported)));
    return found(this.existing(path.join(directory, 'src', subpath.replace(/^\//, '') || 'index')));
  }
}

/** A resolution over a path that may not be there. */
function found(file: string | undefined): Resolution {
  return file === undefined ? { kind: 'missing' } : { kind: 'file', file };
}

/** The module and exported name one local name is taken from. */
interface NameSource {
  readonly specifier: string;
  readonly exported: string;
}

/**
 * Every name a module takes from another module, keyed by the local spelling —
 * an import binding, and a named re-export, which binds the same way for a walk
 * chasing where a name is declared.
 */
function importedNames(source: ts.SourceFile): Map<string, NameSource> {
  const bound = new Map<string, NameSource>();
  for (const statement of source.statements) {
    bindImport(statement, bound);
    bindReExport(statement, bound);
  }
  return bound;
}

/** The names one import declaration binds, default and named alike. */
function bindImport(statement: ts.Statement, bound: Map<string, NameSource>): void {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  const specifier = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (clause?.name !== undefined) bound.set(clause.name.text, { specifier, exported: 'default' });
  const named = clause?.namedBindings;
  if (named === undefined || !ts.isNamedImports(named)) return;
  for (const element of named.elements) {
    bound.set(element.name.text, {
      specifier,
      exported: (element.propertyName ?? element.name).text,
    });
  }
}

/** The names one named re-export binds, which a walk chases exactly as an import. */
function bindReExport(statement: ts.Statement, bound: Map<string, NameSource>): void {
  if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) return;
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
  const clause = statement.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return;
  for (const element of clause.elements) {
    bound.set(element.name.text, {
      specifier: statement.moduleSpecifier.text,
      exported: (element.propertyName ?? element.name).text,
    });
  }
}

/**
 * The declaration a module's default export lands on: the function written at
 * the export itself, or the name it hands on.
 */
function defaultDeclaration(source: ts.SourceFile): ts.Node | undefined {
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
        true
    ) {
      return statement;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return topLevelDeclaration(source, statement.expression.text);
    }
  }
  return undefined;
}

/** A module's own top-level declaration of a name, function or variable alike. */
function topLevelDeclaration(source: ts.SourceFile, name: string): ts.Node | undefined {
  return name === 'default'
    ? defaultDeclaration(source)
    : scopeDeclaration(source.statements, name);
}

/** Where a name lands: its declaration and the module holding it. */
interface Landed {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly declaration: ts.Node;
}

/** The function a declaration is, however it was written. */
function functionOf(declaration: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return undefined;
}

/** The expressions a function hands back, its concise body included. */
function returnedExpressions(declared: ts.FunctionLikeDeclaration): ts.Node[] {
  if (declared.body === undefined) return [];
  if (!ts.isBlock(declared.body)) return [declared.body];
  const returned: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) returned.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declared.body, visit);
  return returned;
}

/**
 * The nearest enclosing declaration of a local name. A helper declared inside
 * the frame that uses it is as ordinary as one a module exports, and reaching
 * only the module's top level would stop the walk at the first of them.
 */
function localDeclaration(identifier: ts.Identifier): ts.Node | undefined {
  let scope: ts.Node = identifier.parent;
  for (;;) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      const declaration = scopeDeclaration(scope.statements, identifier.text);
      if (declaration !== undefined) return declaration;
    }
    if (ts.isSourceFile(scope)) return undefined;
    scope = scope.parent;
  }
}

/** The declaration of one name among a scope's own statements. */
function scopeDeclaration(
  statements: ts.NodeArray<ts.Statement>,
  name: string
): ts.Node | undefined {
  const declared = statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  return declared ?? declaredVariable(statements, name);
}

/** The variable one scope declares under a name, whichever statement carries it. */
function declaredVariable(
  statements: ts.NodeArray<ts.Statement>,
  name: string
): ts.VariableDeclaration | undefined {
  return statements
    .filter((statement) => ts.isVariableStatement(statement))
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
}

/** Whether an expression IS the process environment, directly or by binding. */
function isProcessEnv(node: ts.Node, frame: Frame): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  ) {
    return true;
  }
  return ts.isIdentifier(node) && frame.tainted.has(node.text);
}

/** Whether one node sits inside another, which is what makes a frame a closure. */
function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node = node.parent;
  for (;;) {
    if (current === ancestor) return true;
    if (ts.isSourceFile(current)) return false;
    current = current.parent;
  }
}

/** A node a walk never descends into, because a call is what enters it. */
function isSeparateFrame(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || functionOf(node) !== undefined;
}

/** The walk over one dev server, collecting every environment key it reads. */
class EnvWalk {
  private readonly findings: Finding[] = [];
  private readonly entered = new Set<string>();

  constructor(private readonly repository: Repository) {}

  result(): readonly Finding[] {
    return this.findings;
  }

  /** The module and declaration a name in one module lands on, imports followed. */
  private land(source: ts.SourceFile, file: string, name: string, depth = 0): Landed | undefined {
    if (depth > KEY_DEPTH) return undefined;
    const local = topLevelDeclaration(source, name);
    if (local !== undefined) return { file, source, declaration: local };
    const imported = importedNames(source).get(name);
    if (imported === undefined) return undefined;
    const target = this.repository.resolve(imported.specifier, file);
    if (target.kind === 'external') return undefined;
    if (target.kind === 'missing') {
      this.findings.push({
        file: this.repository.relative(file),
        line: 1,
        key: undefined,
        specifier: `${imported.specifier} (${name})`,
      });
      return undefined;
    }
    const targetSource = this.repository.parse(target.file);
    /* v8 ignore next -- a resolved path is one this rule parsed to resolve it */
    if (targetSource === undefined) return undefined;
    return this.land(targetSource, target.file, imported.exported, depth + 1);
  }

  /** Where a name written in one frame lands, its own scope tried first. */
  private landName(identifier: ts.Identifier, frame: Frame): Landed | undefined {
    const local = localDeclaration(identifier);
    if (local !== undefined) return { file: frame.file, source: frame.source, declaration: local };
    return this.land(frame.source, frame.file, identifier.text);
  }

  /** Which keys one key expression can name, in the frame it was written in. */
  private keysOf(expression: ts.Node, frame: Frame, depth = 0): EnvKey[] {
    const unread: EnvKey = { kind: 'unresolved', text: expression.getText(frame.source) };
    if (depth > KEY_DEPTH) return [unread];
    const written = writtenKey(expression, unread);
    if (written !== undefined) return [written];
    if (ts.isConditionalExpression(expression)) {
      return [
        ...this.keysOf(expression.whenTrue, frame, depth + 1),
        ...this.keysOf(expression.whenFalse, frame, depth + 1),
      ];
    }
    return this.keysOfName(expression, frame, depth) ?? [unread];
  }

  /** The keys a name, a constant's property, or a call can be read as. */
  private keysOfName(expression: ts.Node, frame: Frame, depth: number): EnvKey[] | undefined {
    if (ts.isIdentifier(expression)) return this.keysOfIdentifier(expression, frame, depth);
    if (ts.isPropertyAccessExpression(expression)) {
      return this.keysOfProperty(expression, frame, depth);
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      return this.keysOfCall(expression, expression.expression, frame, depth);
    }
    return undefined;
  }

  private keysOfIdentifier(identifier: ts.Identifier, frame: Frame, depth: number): EnvKey[] {
    const bound = frame.bindings.get(identifier.text);
    if (bound !== undefined) return this.keysOf(bound.node, bound.frame, depth + 1);
    const local = localDeclaration(identifier);
    if (local !== undefined && ts.isVariableDeclaration(local) && local.initializer !== undefined) {
      return this.keysOf(local.initializer, frame, depth + 1);
    }
    const landed = this.landName(identifier, frame);
    const initializer =
      landed !== undefined && ts.isVariableDeclaration(landed.declaration)
        ? landed.declaration.initializer
        : undefined;
    if (landed === undefined || initializer === undefined) {
      return [{ kind: 'unresolved', text: identifier.getText(frame.source) }];
    }
    return this.keysOf(initializer, moduleFrame(landed), depth + 1);
  }

  /** The key a property of a first-party object constant names. */
  private keysOfProperty(
    access: ts.PropertyAccessExpression,
    frame: Frame,
    depth: number
  ): EnvKey[] | undefined {
    if (!ts.isIdentifier(access.expression)) return undefined;
    const landed = this.landName(access.expression, frame);
    if (landed === undefined || !ts.isVariableDeclaration(landed.declaration)) return undefined;
    const initializer = landed.declaration.initializer;
    const literal =
      initializer !== undefined && ts.isAsExpression(initializer)
        ? initializer.expression
        : initializer;
    if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return undefined;
    const property = literal.properties
      .filter((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate))
      .find(
        (candidate) =>
          (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
          candidate.name.text === access.name.text
      );
    if (property === undefined) return undefined;
    return this.keysOf(property.initializer, moduleFrame(landed), depth + 1);
  }

  /** The keys a first-party function hands back, for a key written as a call. */
  private keysOfCall(
    call: ts.CallExpression,
    callee: ts.Identifier,
    frame: Frame,
    depth: number
  ): EnvKey[] | undefined {
    const landed = this.landName(callee, frame);
    const declared = landed === undefined ? undefined : functionOf(landed.declaration);
    if (landed === undefined || declared === undefined) return undefined;
    const inner = this.frameFor(landed, declared, call.arguments, frame);
    const keys = returnedExpressions(declared).flatMap((returned) =>
      this.keysOf(returned, inner, depth + 1)
    );
    return keys.length === 0 ? undefined : keys;
  }

  /** The frame a call creates: its parameters bound to what the caller supplied. */
  private frameFor(
    landed: Landed,
    declared: ts.FunctionLikeDeclaration,
    args: ts.NodeArray<ts.Expression> | undefined,
    caller: Frame
  ): Frame {
    // A function declared inside the frame that calls it closes over that
    // frame's names, so what the caller holds carries in — and is then shadowed
    // by whatever this function's own parameters bind.
    const closure = isWithin(landed.declaration, caller.body);
    const bindings = new Map<string, Bound>(closure ? caller.bindings : []);
    const tainted = new Set<string>(closure ? caller.tainted : []);
    const own = moduleFrame(landed, declared.body ?? landed.source);
    for (const [index, parameter] of declared.parameters.entries()) {
      bindParameter(parameter, args?.[index], { own, caller, bindings, tainted });
    }
    return { ...own, bindings, tainted };
  }

  /** Enters a function the walk reached, once per distinct call site. */
  private enter(
    landed: Landed,
    declared: ts.FunctionLikeDeclaration,
    args: ts.NodeArray<ts.Expression> | undefined,
    caller: Frame
  ): void {
    if (declared.body === undefined) return;
    const frame = this.frameFor(landed, declared, args, caller);
    const signature = [
      this.repository.relative(landed.file),
      String(landed.declaration.getStart(landed.source)),
      [...frame.tainted].toSorted((a, b) => a.localeCompare(b)).join(','),
      (args ?? []).map((argument) => argument.getText(caller.source)).join('|'),
    ].join('#');
    if (this.entered.has(signature)) return;
    this.entered.add(signature);
    this.walk(declared.body, frame);
  }

  /** Follows a call, or a function handed on as a bare value, into its frame. */
  private follow(
    callee: ts.Identifier,
    args: ts.NodeArray<ts.Expression> | undefined,
    frame: Frame
  ): void {
    const landed = this.landName(callee, frame);
    const declared = landed === undefined ? undefined : functionOf(landed.declaration);
    if (landed === undefined || declared === undefined) return;
    this.enter(landed, declared, args, frame);
  }

  /** Walks one frame's body, recording every environment read written in it. */
  walk(body: ts.Node, frame: Frame): void {
    const visit = (node: ts.Node): void => {
      if (node !== body && isSeparateFrame(node)) return;
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        isProcessEnv(node.expression, frame)
      ) {
        this.record(node, frame);
        return;
      }
      if (ts.isCallExpression(node)) {
        this.walkCall(node, frame, visit);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }

  /**
   * One call: its arguments first, then the frame it enters. An argument that
   * NAMES a function is followed too — a hook registered rather than called
   * still runs, and nothing else would ever enter it.
   */
  private walkCall(call: ts.CallExpression, frame: Frame, visit: (node: ts.Node) => void): void {
    for (const argument of call.arguments) {
      visit(argument);
      if (ts.isIdentifier(argument)) this.follow(argument, undefined, frame);
    }
    if (ts.isIdentifier(call.expression)) this.follow(call.expression, call.arguments, frame);
    else visit(call.expression);
  }

  /** Records one read of the environment, under every key it can name. */
  private record(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    frame: Frame
  ): void {
    const keys = ts.isElementAccessExpression(node)
      ? this.keysOf(node.argumentExpression, frame)
      : [{ kind: 'exact', name: node.name.text } satisfies EnvKey];
    for (const key of keys) {
      this.findings.push({
        file: this.repository.relative(frame.file),
        line: frame.source.getLineAndCharacterOfPosition(node.getStart(frame.source)).line + 1,
        key,
        specifier: undefined,
      });
    }
  }
}

/**
 * The key an expression spells out on its own: a literal, or the static prefix
 * of an assembled name. An assembly beginning with a substitution constrains
 * nothing, so it reads as the unresolved key its caller already holds.
 */
function writtenKey(expression: ts.Node, unresolved: EnvKey): EnvKey | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { kind: 'exact', name: expression.text };
  }
  if (!ts.isTemplateExpression(expression)) return undefined;
  const prefix = expression.head.text;
  return prefix === '' ? unresolved : { kind: 'prefix', prefix };
}

/** The frame under construction, which one parameter's binding is written into. */
interface Binding {
  readonly own: Frame;
  readonly caller: Frame;
  readonly bindings: Map<string, Bound>;
  readonly tainted: Set<string>;
}

/** Binds one parameter to what the call site supplied, or to its own default. */
function bindParameter(
  parameter: ts.ParameterDeclaration,
  supplied: ts.Expression | undefined,
  into: Binding
): void {
  if (!ts.isIdentifier(parameter.name)) return;
  const name = parameter.name.text;
  into.bindings.delete(name);
  into.tainted.delete(name);
  const node = supplied ?? parameter.initializer;
  if (node === undefined) return;
  const bound: Bound = { node, frame: supplied === undefined ? into.own : into.caller };
  into.bindings.set(name, bound);
  if (isProcessEnv(bound.node, bound.frame)) into.tainted.add(name);
}

/** A frame over one module's code, binding nothing and tainting nothing. */
function moduleFrame(landed: Landed, body: ts.Node = landed.source): Frame {
  return {
    file: landed.file,
    source: landed.source,
    body,
    bindings: new Map(),
    tainted: new Set(),
  };
}

/** The package whose `dev` script is being resolved, and the repository holding it. */
interface Server {
  readonly repository: Repository;
  readonly packageDir: string;
  readonly manifest: Manifest;
}

/** One dev server's entry: the file its `dev` script executes, parsed. */
interface Entry {
  readonly file: string;
  readonly source: ts.SourceFile;
}

/** One command's tokens. A piece of a split script with none is not a command. */
type Command = readonly [string, ...string[]];

/**
 * The first-party files a `dev` script executes, one per command it runs, with
 * `undefined` standing for a command that resolves to no first-party file.
 *
 * A shell operator ends one command and starts ANOTHER PROGRAM, so every
 * command is resolved and every resolved one is walked. Taking only the last
 * would drop each earlier program's reads without reporting anything, and a
 * walk that silently drops a subtree reads as a clean pass — which is the one
 * thing this rule may never do.
 *
 * An operator that produces no command produces no finding: a trailing `&`
 * backgrounds the program before it and is a legal shape, so the empty piece
 * beside it is dropped rather than reported. A script that yields no command at
 * all is the unreadable one, and is the `undefined` this returns. The
 * distinction is load-bearing in both directions — a rule that fires on a legal
 * shape blocks a correct change and teaches its readers to disbelieve it, which
 * costs exactly what the rule was built to buy.
 */
function entriesFor(
  server: Server,
  script: string,
  seen: ReadonlySet<string> = new Set()
): readonly (Entry | undefined)[] {
  const commands = script
    .split(COMMAND_SEPARATOR)
    .map((command): readonly string[] => command.split(/\s+/).filter((token) => token !== ''))
    .filter((tokens): tokens is Command => tokens.length > 0);
  if (commands.length === 0) return [undefined];
  return commands.flatMap((tokens) => commandEntries(server, tokens, seen));
}

/**
 * The first-party file ONE command executes.
 *
 * A wrapper chain hands its work to the command it was given, so the LAST file
 * token is the program that runs and the ones before it are the environment
 * loader it runs behind. A command that names no file at all is either another
 * of this manifest's scripts, or a runner evaluating this package's own config —
 * which is where such a server reads its environment.
 */
function commandEntries(
  server: Server,
  tokens: Command,
  seen: ReadonlySet<string>
): readonly (Entry | undefined)[] {
  const executed = tokens
    .filter((token) => EXECUTABLE_EXTENSIONS.some((extension) => token.endsWith(extension)))
    .map((token) => path.resolve(server.packageDir, token))
    .filter((candidate) => server.repository.parse(candidate) !== undefined);
  const last = executed.at(-1);
  if (last !== undefined) return [entryAt(server.repository, last)];

  const [first, ...rest] = tokens;
  if (SCRIPT_RUNNERS.has(first)) return nestedEntries(server, rest, seen);
  const config = RUNNER_CONFIGS[first];
  return [
    config === undefined
      ? undefined
      : entryAt(server.repository, path.join(server.packageDir, config)),
  ];
}

/** The entries of the manifest script a package-manager invocation names. */
function nestedEntries(
  server: Server,
  rest: readonly string[],
  seen: ReadonlySet<string>
): readonly (Entry | undefined)[] {
  const named = rest.find((token) => !SCRIPT_RUNNERS.has(token));
  const nested = named === undefined ? undefined : server.manifest.scripts?.[named];
  if (named === undefined || nested === undefined || seen.has(named)) return [undefined];
  return entriesFor(server, nested, new Set([...seen, named]));
}

/** The entry at one path, when a file is there to be one. */
function entryAt(repository: Repository, file: string): Entry | undefined {
  const source = repository.parse(file);
  return source === undefined ? undefined : { file, source };
}

/** Renders a pattern list the way a violation names it. */
function renderPatterns(patterns: readonly string[]): string {
  return patterns.map((pattern) => `\`${pattern}\``).join(', ');
}

/** What one finding says, or nothing when the pass-through list covers it. */
function messageFor(
  workspace: string,
  finding: Finding,
  patterns: readonly string[]
): string | undefined {
  if (finding.specifier !== undefined) {
    return (
      `the \`${DEV_TASK}\` server \`${workspace}\` starts reaches \`${finding.specifier}\`, which ` +
      'resolves to no file in this repository, so the environment keys behind it go unread.'
    );
  }
  const key = finding.key;
  /* v8 ignore next -- a finding carries a key or a specifier, and nothing makes one with neither */
  if (key === undefined) return undefined;
  if (key.kind === 'unresolved') {
    return (
      `the \`${DEV_TASK}\` server \`${workspace}\` starts reads the environment under ` +
      `\`${key.text}\`, which resolves to no key and no static prefix, so nothing here can say ` +
      `whether the \`${DEV_TASK}\` task passes it through.`
    );
  }
  if (key.kind === 'prefix') {
    if (patternsCoverPrefix(patterns, key.prefix)) return undefined;
    return (
      `the \`${DEV_TASK}\` server \`${workspace}\` starts reads the environment under a name it ` +
      `assembles, and every name it can produce begins \`${key.prefix}\`, which the ` +
      `\`${DEV_TASK}\` task's pass-through patterns (${renderPatterns(patterns)}) do not cover.`
    );
  }
  if (patterns.some((pattern) => patternCovers(pattern, key.name))) return undefined;
  return (
    `the \`${DEV_TASK}\` server \`${workspace}\` starts reads \`${key.name}\` from the ` +
    `environment, and the \`${DEV_TASK}\` task passes through ${renderPatterns(patterns)}. Turbo ` +
    'runs the task in strict mode, so a variable the list does not name is stripped before the ' +
    'server sees it.'
  );
}

/** Every violation one workspace's `dev` server accounts for. */
function violationsForServer(
  repository: Repository,
  fileSystem: FileSystemHost,
  manifestPath: string,
  patterns: readonly string[]
): ArchViolation[] {
  const manifest = readManifest(fileSystem, manifestPath);
  const script = manifest.scripts?.[DEV_TASK];
  if (script === undefined) return [];
  const packageDir = path.dirname(manifestPath);
  const workspace = manifest.name ?? repository.relative(packageDir);
  const entries = entriesFor({ repository, packageDir, manifest }, script);
  const violations = new Map<string, ArchViolation>();
  if (entries.includes(undefined)) {
    const message =
      `\`${workspace}\` declares \`${DEV_TASK}\` as \`${script}\`, a shape this rule cannot ` +
      'resolve to the first-party file it runs, so nothing states what that server reads ' +
      'from the environment.';
    const file = repository.relative(manifestPath);
    violations.set(`${file}:1:${message}`, { file, line: 1, message });
  }
  const walk = new EnvWalk(repository);
  for (const entry of entries) {
    if (entry === undefined) continue;
    walk.walk(entry.source, {
      file: entry.file,
      source: entry.source,
      body: entry.source,
      bindings: new Map(),
      tainted: new Set(),
    });
  }
  for (const finding of walk.result()) {
    const message = messageFor(workspace, finding, patterns);
    if (message === undefined) continue;
    violations.set(`${finding.file}:${String(finding.line)}:${message}`, {
      file: finding.file,
      line: finding.line,
      message,
    });
  }
  return [...violations.values()];
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project): ArchViolation[] {
    const fileSystem = project.getFileSystem();
    const repository = new Repository(fileSystem, REPO_ROOT);
    const patterns = passedThroughPatterns(fileSystem, REPO_ROOT);
    return fileSystem
      .globSync(manifestGlobs(REPO_ROOT))
      .toSorted((a, b) => a.localeCompare(b))
      .flatMap((manifestPath) =>
        violationsForServer(repository, fileSystem, manifestPath, patterns)
      );
  },
};

export default rule;
