import { Node, SyntaxKind } from 'ts-morph';
import { WRITTEN_EXTENSIONS } from '../../written-extensions.mjs';
import {
  failWith,
  isLocalSpecifier,
  isRepoPath,
  isTestFile,
  relativePath,
  sourceFileAt,
} from '../lib/paths.js';
import { WEB_SOURCE_TREE } from '../lib/source-scope.js';
import type { CallExpression, ObjectLiteralExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every TanStack mutation under `apps/web` either CARRIES an `Idempotency-Key`
 * or DECLARES, from a closed set, why it sends none. There is no third state.
 * A mutation is one declared through `useMutation` or one built straight on a
 * client's mutation cache.
 *
 * WHY THIS IS A RULE AND NOT A CONVENTION. A mutation's retry posture is read
 * off the wire: `customFetch` records whether the key rode the request, and
 * `shouldRetryMutation` retries a transient server response only for a request
 * that carried one. So the KEY is the permission, and a mutation without one
 * silently keeps the narrow network-only retry — a write that a proxy blip
 * loses stays lost, with nothing failing and nothing to notice. The absence is
 * invisible at the call site by construction; only a rule standing over every
 * call site can tell a deliberate omission from a forgotten one.
 *
 * WHAT COUNTS AS CARRYING A KEY is the same structural proof the server's
 * `mutating-routes-prove-idempotency` demands of a route: the mutation's own
 * options must REACH the key helper, directly or through a helper declared in
 * the same file (by fix-point). A helper in another file fails, deliberately —
 * the proof must stay visible where the mutation is declared, and a comment
 * claiming the key satisfies nothing here because every read below is an AST
 * node kind.
 *
 * WHAT COUNTS AS DECLARING AN EXEMPTION is a `meta` whose initializer is a CALL
 * to {@link EXEMPTION_DECLARATION}. An object literal spelling the same shape by
 * hand is refused: the call is what validates the class against the closed set,
 * so a hand-rolled literal is exactly the unvalidated class the declaration
 * exists to refuse.
 *
 * RESOLUTION, AND ITS ONE LIMIT. Selecting a `useMutation` call resolves through
 * the compiler's alias chain — `import { useMutation as m }` is still a mutation,
 * and a same-named local function is not one. A cache build is selected by its
 * call chain instead, for the reason {@link isCacheBuildCall} gives. The
 * DECLARATION module cannot be resolved the same way: the arch project carries
 * empty compiler options, so the `@/…` alias every web file opens it through
 * resolves nowhere, and a checker judgement there would read `undefined` on
 * every file and report a clean repository. {@link resolveLocalSpecifier} resolves that alias itself and
 * matches on the resolved MODULE plus the EXPORTED name (never the local
 * binding), so a helper renamed on the way in is still recognized. If the arch
 * project ever gains `paths`, this can collapse into the checker path.
 *
 * BLINDNESS IS THE FAILURE MODE THIS GUARDS. Every clause above reports nothing
 * when it stops resolving, which reads exactly like a clean tree. So a CLEAN
 * result must additionally prove the rule still recognizes both arms — see
 * {@link assertRecognizerIsLive}. A run with violations needs no such proof: it
 * has just demonstrated it can see.
 */

/** The module that publishes the key helpers and the exemption declaration. */
export const DECLARATION_MODULE = `${WEB_SOURCE_TREE}lib/api/idempotent-mutation.ts`;

/** The package a mutation is selected from, wherever node resolution lands inside it. */
const TANSTACK_PACKAGE = '@tanstack/react-query/';

/** The exported hook a component declares its mutations through. */
const MUTATION_HOOK = 'useMutation';

/**
 * The call chain that builds a mutation straight on a client's cache,
 * `client.getMutationCache().build(client, options)`, for a write sent outside
 * any component.
 */
const CACHE_ACCESSOR = 'getMutationCache';
const CACHE_BUILDER = 'build';

/**
 * The exported names that put a key on the wire. `idempotencyKeyFor` is listed
 * beside the header wrapper because a call site may mint the key itself and
 * spell the header inline; both end at the same WeakMap.
 */
const KEY_HELPERS: ReadonlySet<string> = new Set(['idempotentHeaders', 'idempotencyKeyFor']);

/** The exported name that declares, from the closed set, why no key is sent. */
const EXEMPTION_DECLARATION = 'idempotencyExempt';

/** TanStack's own slot for a fact attached to a mutation. */
const DECLARATION_PROPERTY = 'meta';

const fail = failWith('web-mutations-declare-idempotency');

const UNDECLARED =
  'This mutation neither carries an Idempotency-Key nor declares why it sends none, ' +
  'so it silently keeps the network-only retry: a write lost to a transient 5xx stays ' +
  `lost. Reach ${[...KEY_HELPERS].join('/')} from the mutation's own options, or declare ` +
  `${DECLARATION_PROPERTY}: ${EXEMPTION_DECLARATION}('<class>') from the closed set in ` +
  `${DECLARATION_MODULE}.`;

const OPAQUE_OPTIONS =
  'This mutation is handed an options value rather than an object literal, so neither ' +
  'its key nor its exemption is visible where it is declared. Inline the options at the ' +
  'call site — a mutation whose idempotency posture is assembled elsewhere cannot be proven.';

/**
 * The repo-relative module a repo-local specifier names, or undefined for a
 * package specifier. Extension-less because the extension a specifier writes is
 * not the one its source carries; `..` is walked rather than string-matched so a
 * specifier climbing out of its directory lands where the compiler would put it.
 */
function resolveLocalSpecifier(importer: SourceFile, specifier: string): string | undefined {
  if (!isLocalSpecifier(specifier)) return undefined;
  const withoutExtension = specifier.replace(WRITTEN_EXTENSIONS, '');
  if (withoutExtension.startsWith('@/')) {
    return `${WEB_SOURCE_TREE}${withoutExtension.slice(2)}.ts`;
  }
  const segments = relativePath(importer).split('/').slice(0, -1);
  for (const part of withoutExtension.split('/')) {
    if (part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `${segments.join('/')}.ts`;
}

/**
 * Local binding name → exported name, for every value binding one file takes on
 * {@link DECLARATION_MODULE}. Keyed on the LOCAL name because that is what a
 * call site writes, valued on the EXPORTED name because that is what the rule
 * judges — which is the whole reason an alias cannot launder a helper past it.
 */
function declaredBindings(sourceFile: SourceFile): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const module = resolveLocalSpecifier(sourceFile, declaration.getModuleSpecifierValue());
    if (module === undefined || !isRepoPath(module, DECLARATION_MODULE)) continue;
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.isTypeOnly()) continue;
      const exported = specifier.getName();
      bindings.set(specifier.getAliasNode()?.getText() ?? exported, exported);
    }
  }
  return bindings;
}

/** A function declared in this file under `name`, as a node to search. */
function sameFileFunction(sourceFile: SourceFile, name: string): Node | undefined {
  const declared = sourceFile.getFunction(name);
  if (declared !== undefined) return declared;
  const initializer = sourceFile.getVariableDeclaration(name)?.getInitializer();
  return initializer !== undefined &&
    (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

/** The name every call under `node` invokes, where the callee is a plain identifier. */
function calledNames(node: Node): string[] {
  const names: string[] = [];
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) names.push(callee.getText());
  }
  return names;
}

/**
 * Whether anything reachable from `node` calls a key helper. Same-file
 * functions are followed to a fix-point; `visited` closes the recursion over a
 * self- or mutually-recursive helper.
 */
function reachesKeyHelper(
  node: Node,
  sourceFile: SourceFile,
  bindings: ReadonlyMap<string, string>,
  visited: Set<string>
): boolean {
  for (const local of calledNames(node)) {
    const exported = bindings.get(local);
    if (exported !== undefined && KEY_HELPERS.has(exported)) return true;
    if (visited.has(local)) continue;
    const body = sameFileFunction(sourceFile, local);
    if (body === undefined) continue;
    visited.add(local);
    if (reachesKeyHelper(body, sourceFile, bindings, visited)) return true;
  }
  return false;
}

/** Whether the options declare an exemption through the validating call. */
function declaresExemption(
  options: ObjectLiteralExpression,
  bindings: ReadonlyMap<string, string>
): boolean {
  const property = options.getProperty(DECLARATION_PROPERTY);
  if (!Node.isPropertyAssignment(property)) return false;
  const initializer = property.getInitializer();
  if (!Node.isCallExpression(initializer)) return false;
  const callee = initializer.getExpression();
  return Node.isIdentifier(callee) && bindings.get(callee.getText()) === EXEMPTION_DECLARATION;
}

/**
 * Whether this call IS TanStack's `useMutation`, through the compiler's alias
 * chain rather than through the text at the call site: a local function of the
 * same name is not one, and the hook imported under another name still is.
 */
function isMutationCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return false;
  const symbol = callee.getSymbol();
  const target = symbol?.getAliasedSymbol() ?? symbol;
  if (target?.getName() !== MUTATION_HOOK) return false;
  return target
    .getDeclarations()
    .some((declaration) => declaration.getSourceFile().getFilePath().includes(TANSTACK_PACKAGE));
}

/**
 * Whether this call builds a mutation on a client's mutation cache. Selected by
 * the shape of the chain, not by symbol: the client is imported through the
 * `@/…` alias, which the arch project resolves nowhere, so its methods carry no
 * declaration to follow.
 */
function isCacheBuildCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== CACHE_BUILDER) return false;
  const receiver = callee.getExpression();
  if (!Node.isCallExpression(receiver)) return false;
  const accessor = receiver.getExpression();
  return Node.isPropertyAccessExpression(accessor) && accessor.getName() === CACHE_ACCESSOR;
}

/**
 * Where the options sit in a call that declares a mutation, or undefined for any
 * other call. The hook takes them first; a cache build takes the client first.
 */
function optionsPosition(call: CallExpression): number | undefined {
  if (isMutationCall(call)) return 0;
  if (isCacheBuildCall(call)) return 1;
  return undefined;
}

interface Tally {
  readonly violations: ArchViolation[];
  keyed: number;
  exempt: number;
}

function judgeFile(sourceFile: SourceFile, tally: Tally): void {
  const bindings = declaredBindings(sourceFile);
  const file = sourceFile.getFilePath();
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const position = optionsPosition(call);
    if (position === undefined) continue;
    const line = call.getStartLineNumber();
    const options = call.getArguments()[position];
    if (options === undefined || !Node.isObjectLiteralExpression(options)) {
      tally.violations.push({ file, line, message: OPAQUE_OPTIONS });
      continue;
    }
    if (declaresExemption(options, bindings)) {
      tally.exempt += 1;
      continue;
    }
    if (reachesKeyHelper(options, sourceFile, bindings, new Set())) {
      tally.keyed += 1;
      continue;
    }
    tally.violations.push({ file, line, message: UNDECLARED });
  }
}

/**
 * A clean run proves it can still see both arms.
 *
 * Every judgement above returns false when its resolution stops working, and
 * false on both arms is a violation — so a broken recognizer gets LOUDER, not
 * quieter, for the mutations it still finds. What goes quiet instead is the
 * selector: if `useMutation` stops resolving to TanStack, no call is judged at
 * all and the rule reports a clean tree having read nothing. Counting both arms
 * is what turns that silence into noise.
 */
function assertRecognizerIsLive(tally: Tally): void {
  if (tally.keyed === 0) {
    fail(
      'recognizes no keyed mutation anywhere under the web tree, so it is reporting a ' +
        'clean tree without having proven a single key. Either the mutation hook stopped ' +
        `resolving to ${TANSTACK_PACKAGE}, or ${DECLARATION_MODULE} moved out from under ` +
        'the specifier resolution.'
    );
  }
  if (tally.exempt === 0) {
    fail(
      'recognizes no declared exemption anywhere under the web tree, so the arm that ' +
        'admits a keyless mutation is unexercised and would pass whatever it was handed. ' +
        `Either every mutation now carries a key — delete ${EXEMPTION_DECLARATION} rather ` +
        'than leaving this check standing over nothing — or the declaration stopped resolving.'
    );
  }
}

const rule: ArchRule = {
  name: 'web-mutations-declare-idempotency',
  check(project: Project): ArchViolation[] {
    const scanned = project.getSourceFiles().filter((sourceFile) => {
      const filePath = relativePath(sourceFile);
      return filePath.includes(WEB_SOURCE_TREE) && !isTestFile(filePath);
    });
    if (scanned.length === 0) {
      fail(
        `no scanned file lives under '${WEB_SOURCE_TREE}', so this rule stands over an ` +
          'empty scope and reports a clean repository having read nothing.'
      );
    }
    if (sourceFileAt(project, DECLARATION_MODULE) === undefined) {
      fail(
        `'${DECLARATION_MODULE}' names no file in the scanned tree, so neither the key ` +
          'helpers nor the exemption declaration can be recognized and every mutation ' +
          'below would read as undeclared. Point this at the module that publishes them.'
      );
    }
    const tally: Tally = { violations: [], keyed: 0, exempt: 0 };
    for (const sourceFile of scanned) judgeFile(sourceFile, tally);
    if (tally.violations.length === 0) assertRecognizerIsLive(tally);
    return tally.violations;
  },
};

export default rule;
