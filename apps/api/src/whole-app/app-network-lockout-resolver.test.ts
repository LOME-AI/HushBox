/**
 * # The caller network a composite counter counts comes from the refusing resolver
 *
 * A counter keyed on one account AND the network the request came from is what
 * keeps naming an account from being a way to lock its owner out: what one
 * network may spend is its own. That property rests entirely on which resolver
 * answered the network. `trustedCallerIpId` REFUSES when production carries no
 * address; `callerIpId` answers a sentinel identity instead, and a composite
 * built on the sentinel puts every caller behind an edge fault into one shared
 * window per account — the denial channel the composite exists to close,
 * reachable by an attacker who can induce the fault.
 *
 * Outside production both resolvers read the same headers, so swapping one for
 * the other changes no test's outcome; the domain still refuses on a null
 * network, so the swap degrades silently rather than breaking. This file is
 * what makes it break.
 *
 * ## What "per-network" means here
 *
 * Not a name and not a list of handlers, either of which would go on passing
 * the day a counter nobody added to the list lands. A counter keyed on the
 * caller's network is keyed on the network AND something else, and
 * `compositeRateLimitId` is the primitive built for joining two parts into one
 * rate-limit identity. The subject is therefore derived: the closure of
 * functions reaching that primitive, and the spends whose identity comes out of
 * it — read from the identity expression where that can be followed backwards,
 * and from the spending function's own reach where it cannot.
 *
 * `compositeRateLimitId` is the seed, not the only way to build a composite.
 * Nothing obliges one to go through it, and at least one does not:
 * `resolveCallerId` in `apps/api/src/middleware/rate-limit.ts` joins the
 * caller's network identity and the canonicalized link credential by
 * concatenation, into what that module's own comment calls the composite
 * `ip:<sha256>:link:<sha256>`. What that costs this walk is the construction
 * escape below.
 *
 * ## Reach
 *
 * Spends are the calls to `consume` and `consumeLayers` imported from
 * `lib/rate-limit`, in a non-test module outside `lib/rate-limit` itself —
 * the same subject as `app-flow-counter-citations.test.ts`, which asks the
 * other question about the same lines, read by the module both files import,
 * `test-support/rate-limit-spend-sites.ts`. Neither file may keep a reading of
 * its own: a gate whose subject has narrowed reports nothing rather than
 * reporting something wrong. Resolutions are the calls to either resolver,
 * under whatever name a barrel re-exports it as.
 *
 * The link between the two is a call graph over every function-like in the
 * Worker, with edges to the functions a body calls by name and to the callbacks
 * it writes inline. Names rather than resolved symbols means two functions
 * sharing a name are both reached — an over-approximation, which only ever
 * widens what a resolver is held to.
 *
 * Reading unreadable input throws rather than skipping it: an identity
 * expression whose shape this file cannot follow, a layer list it cannot
 * destructure, an identifier binding to no declaration. A check that passes
 * over what it cannot see reads exactly like one that saw nothing wrong.
 *
 * ## What it cannot prove
 *
 * That a composite built without the primitive is covered. An identity
 * concatenated together instead is invisible here, so a per-network lockout
 * built that way is spent behind either resolver with nothing going red. The
 * rule to carry away: build one through `compositeRateLimitId` and it is
 * covered; concatenate it and it is not.
 *
 * For a counter counted in a FLOW, a declared marker would close that, and
 * `claimed-account-per-network` (`lib/rate-limit/posture.ts`) already names the
 * property — it is what this Worker's per-network lockouts declare. Seeding
 * on it as well was considered and deliberately not done: it would catch a
 * concatenated identity only where the counter also declared the marker, and a
 * marker is self-declared, so it is blind to the same person being wrong twice.
 *
 * That the pipeline stage's `ip:<sha256>:link:<sha256>` is bounded at all, and
 * no marker can be the answer there. It is invisible twice over — built outside
 * the primitive, and spent at `lib/rate-limit/capability.ts`, inside the
 * directory this walk excludes, from a layer list handed in as a parameter.
 * `claimed-account-per-network` cannot reach it either: those layers are counted
 * at the edge, that marker is flow-only, and `PostureLayer`'s edge arm types its
 * identity as `EdgeIdentity`, so declaring it there fails to compile rather than
 * merely being wrong. That marker names account-and-network besides, where this
 * composite is network-and-link-credential. That escape needs an answer
 * neither this walk nor that marker supplies.
 *
 * That the refusing resolver's value is the one the composite is built from. It
 * proves that no sentinel resolution reaches a composite spend and that a
 * refusing one does, which is the whole of the regression it exists to catch
 * but is weaker than a dataflow proof that the two are the same value.
 *
 * That a flow reached through a port method is covered: edges are direct calls
 * by name and inline callbacks, so a domain function invoked as `deps.run()`
 * is reached only if something also calls it by its own name.
 *
 * That a composite built for something other than a spend is bounded. The dev
 * auth reset composites the login and recovery lockouts' own identities to
 * DELETE those keys, and resolves the network half with the sentinel — which is
 * correct, since a reset that refuses during an edge fault would bound nothing —
 * and is outside this subject because it spends no counter.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  API_SRC,
  PRIMITIVE_DIR,
  namedImportElements,
  repoRelative,
  spendBindings,
} from '../test-support/rate-limit-spend-sites.js';
import type { SpendFunction } from '../test-support/rate-limit-spend-sites.js';

/**
 * Trees this walk does not read: `test-support` is test-only code importing
 * vitest, so a resolver named there stands for a fixture rather than for
 * anything a request reaches.
 */
const UNWALKED: ReadonlySet<string> = new Set(['test-support']);

/** The one primitive that joins two parts into one rate-limit identity. */
const COMPOSITING_SEED = 'compositeRateLimitId';

/** The module both resolvers are declared in, named so a rename fails loudly. */
const RESOLVER_MODULE = path.join(API_SRC, 'lib', 'redis', 'caller-ip.ts');

/** The two resolvers under the names they are declared with. */
const RESOLVERS: Readonly<Record<string, 'sentinel' | 'refusing'>> = {
  callerIpId: 'sentinel',
  trustedCallerIpId: 'refusing',
};

/** Expression shapes whose value is whatever they wrap. */
type PassThrough =
  | ts.AsExpression
  | ts.AwaitExpression
  | ts.NonNullExpression
  | ts.ParenthesizedExpression
  | ts.SatisfiesExpression
  | ts.SpreadElement;

function* sourceFilePaths(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!UNWALKED.has(entry.name)) yield* sourceFilePaths(full);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.includes('.setup.')) continue;
    yield full;
  }
}

const SOURCES: ReadonlyMap<string, ts.SourceFile> = new Map(
  [...sourceFilePaths(API_SRC)].map((file) => [
    file,
    ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS
    ),
  ])
);

/** Where one node sits, as `path:line`. */
function locationOf(node: ts.Node, source: ts.SourceFile): string {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `${repoRelative(source.fileName)}:${String(line)}`;
}

/**
 * The chain of scopes above a node. The AST declares `parent` as always
 * present, which a source file's is not, so the two assertions below read it
 * as the optional it is at runtime.
 */
function* ancestors(node: ts.Node): Generator<ts.Node> {
  for (
    let current = node.parent as ts.Node | undefined;
    current !== undefined;
    current = current.parent as ts.Node | undefined
  ) {
    yield current;
  }
}

/** The named exports one statement carries. */
function namedExportElements(statement: ts.Statement): readonly ts.ExportSpecifier[] {
  if (!ts.isExportDeclaration(statement)) return [];
  const clause = statement.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return [];
  return clause.elements;
}

/**
 * Every `export { original as exported } from …` in the Worker, so a name a
 * barrel republishes resolves back to what it binds — the identity barrel
 * publishes the resolvers as `resolveCallerIpId` and `resolveTrustedCallerIpId`,
 * and a walk reading only import text would see two names it never heard of.
 */
const REEXPORT_ALIASES: ReadonlyMap<string, string> = (() => {
  const aliases = new Map<string, string>();
  for (const source of SOURCES.values()) {
    for (const statement of source.statements) {
      for (const element of namedExportElements(statement)) {
        if (element.propertyName !== undefined) {
          aliases.set(element.name.text, element.propertyName.text);
        }
      }
    }
  }
  return aliases;
})();

/** One name followed back through the re-export aliases to what it binds. */
function canonicalName(name: string): string {
  const seen = new Set<string>([name]);
  let current = name;
  for (;;) {
    const next = REEXPORT_ALIASES.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/** The names one module imports, keyed to the canonical name each reaches. */
function importedNames(source: ts.SourceFile): ReadonlyMap<string, string> {
  const bound = new Map<string, string>();
  for (const statement of source.statements) {
    for (const element of namedImportElements(statement)) {
      bound.set(element.name.text, canonicalName((element.propertyName ?? element.name).text));
    }
  }
  return bound;
}

/** One function-like, and what its own body reaches. */
interface FunctionNode {
  readonly id: string;
  readonly name: string | undefined;
  readonly calls: ReadonlySet<string>;
  readonly nested: readonly string[];
}

function isFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** The name a binding gives an inline function. */
function nameFromBinding(parent: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/** The name a function-like is reachable by, or nothing when it is written inline. */
function declaredName(node: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (ts.isFunctionExpression(node) && node.name !== undefined) return node.name.text;
  return nameFromBinding(node.parent);
}

/** The names one body calls directly, and the callbacks it writes inline. */
function bodyReach(
  node: ts.SignatureDeclaration,
  source: ts.SourceFile
): { readonly calls: ReadonlySet<string>; readonly nested: readonly string[] } {
  const calls = new Set<string>();
  const nested: string[] = [];
  const scan = (inner: ts.Node): void => {
    if (isFunctionLike(inner)) {
      nested.push(locationOf(inner, source));
      return;
    }
    if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
      calls.add(inner.expression.text);
    }
    ts.forEachChild(inner, scan);
  };
  ts.forEachChild(node, scan);
  return { calls, nested };
}

/** Every function-like in the Worker, with the calls and callbacks its own body holds. */
const NODES: ReadonlyMap<string, FunctionNode> = (() => {
  const nodes = new Map<string, FunctionNode>();
  for (const source of SOURCES.values()) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const id = locationOf(node, source);
        nodes.set(id, { id, name: declaredName(node), ...bodyReach(node, source) });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return nodes;
})();

const NODES_BY_NAME: ReadonlyMap<string, readonly string[]> = (() => {
  const byName = new Map<string, string[]>();
  for (const node of NODES.values()) {
    if (node.name === undefined) continue;
    const existing = byName.get(node.name) ?? [];
    existing.push(node.id);
    byName.set(node.name, existing);
  }
  return byName;
})();

const REACH_CACHE = new Map<string, ReadonlySet<string>>();

/** Everything one function can reach, itself included. */
function reach(functionId: string): ReadonlySet<string> {
  const cached = REACH_CACHE.get(functionId);
  if (cached !== undefined) return cached;
  const seen = new Set<string>([functionId]);
  const queue = [functionId];
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    const node = NODES.get(current);
    if (node === undefined) continue;
    const next = [
      ...node.nested,
      ...[...node.calls].flatMap((name) => NODES_BY_NAME.get(name) ?? []),
    ];
    for (const id of next) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  REACH_CACHE.set(functionId, seen);
  return seen;
}

/** The nearest function-like a node sits inside. */
function enclosingFunctionId(node: ts.Node, source: ts.SourceFile): string {
  for (const scope of ancestors(node)) {
    if (isFunctionLike(scope)) return locationOf(scope, source);
  }
  throw new Error(`${locationOf(node, source)}: sits in no function this walk can name.`);
}

/**
 * The nearest function-like around a node that something can call by name. A
 * spend written inside a `.andThen` callback belongs, for the purpose of asking
 * what its owner reaches, to the function that built the chain — the callback
 * itself calls almost nothing.
 */
function owningFunctionId(node: ts.Node, source: ts.SourceFile): string {
  let innermost: string | undefined;
  for (const scope of ancestors(node)) {
    if (!isFunctionLike(scope)) continue;
    innermost ??= locationOf(scope, source);
    if (declaredName(scope) !== undefined) return locationOf(scope, source);
  }
  if (innermost === undefined) {
    throw new Error(`${locationOf(node, source)}: sits in no function this walk can name.`);
  }
  return innermost;
}

/** Every function that composites a rate-limit identity, as the primitive's closure. */
const COMPOSITING: ReadonlySet<string> = (() => {
  const names = new Set<string>([COMPOSITING_SEED]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of NODES.values()) {
      if (node.name === undefined || names.has(node.name)) continue;
      if ([...node.calls].some((call) => names.has(call))) {
        names.add(node.name);
        changed = true;
      }
    }
  }
  return names;
})();

/** What a backward read of one spend's identity found. */
interface Slice {
  compositing: boolean;
  unresolved: boolean;
}

/** The statements one scope holds, for scopes that hold any. */
function scopeStatements(node: ts.Node): readonly ts.Statement[] {
  if (ts.isBlock(node)) return node.statements;
  if (ts.isSourceFile(node)) return node.statements;
  return [];
}

/** The declaration one statement makes of a name, when it makes one. */
function declarationOf(statement: ts.Statement, text: string): ts.Node | undefined {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === text
    );
  }
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === text ? statement : undefined;
  }
  return namedImportElements(statement).find((element) => element.name.text === text);
}

/** The declaration of one name among a scope's statements. */
function declarationIn(statements: readonly ts.Statement[], text: string): ts.Node | undefined {
  for (const statement of statements) {
    const declared = declarationOf(statement, text);
    if (declared !== undefined) return declared;
  }
  return undefined;
}

/** The parameter of one scope that binds a name, when the scope takes parameters. */
function parameterNamed(scope: ts.Node, text: string): ts.ParameterDeclaration | undefined {
  if (!isFunctionLike(scope)) return undefined;
  return scope.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === text
  );
}

/** The declaration one identifier binds to, searched outward through its scopes. */
function findDeclaration(identifier: ts.Identifier): ts.Node | undefined {
  const { text } = identifier;
  for (const scope of ancestors(identifier)) {
    const declared = parameterNamed(scope, text) ?? declarationIn(scopeStatements(scope), text);
    if (declared !== undefined) return declared;
  }
  return undefined;
}

/**
 * The value a combinator hands its callback: `X.andThen((v) => …)` binds `v` to
 * whatever `X` carries, so a parameter declared that way is read as `X`.
 */
function combinatorSource(parameter: ts.ParameterDeclaration): ts.Expression | undefined {
  const owner = parameter.parent;
  if (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) return undefined;
  const call = owner.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(owner)) return undefined;
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  return call.expression.expression;
}

/** The expression a declaration carries, for the declarations that carry one. */
function declaredValue(declaration: ts.Node): ts.Node | undefined {
  if (ts.isVariableDeclaration(declaration)) return declaration.initializer;
  if (ts.isParameter(declaration)) return combinatorSource(declaration);
  return undefined;
}

function isPassThrough(node: ts.Node): node is PassThrough {
  return (
    ts.isAsExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isSpreadElement(node)
  );
}

const TERMINAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.TrueKeyword,
]);

/** An identity part that carries nothing further to read. */
function isTerminal(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || TERMINAL_KINDS.has(node.kind);
}

/** The value one object-literal property carries. */
function propertyValue(property: ts.ObjectLiteralElementLike): ts.Node {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  throw new Error('a rate-limit identity holds an object property this walk cannot read.');
}

/** The parts of an identity written as a fixed arrangement of sub-expressions. */
function pairedParts(node: ts.Node): readonly ts.Node[] | undefined {
  if (ts.isPropertyAccessExpression(node)) return [node.expression];
  if (ts.isElementAccessExpression(node)) return [node.expression, node.argumentExpression];
  if (ts.isBinaryExpression(node)) return [node.left, node.right];
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  if (ts.isPrefixUnaryExpression(node)) return [node.operand];
  if (isPassThrough(node)) return [node.expression];
  return undefined;
}

/** The parts of an identity written as a list, refusing a shape it cannot read. */
function listParts(node: ts.Node): readonly ts.Node[] {
  if (ts.isTemplateExpression(node)) return node.templateSpans.map((span) => span.expression);
  if (ts.isArrayLiteralExpression(node)) return [...node.elements];
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.map((property) => propertyValue(property));
  }
  if (isTerminal(node)) return [];
  throw new Error(
    `a rate-limit identity written as ${ts.SyntaxKind[node.kind]} is a shape this walk cannot ` +
      'read — an identity read as nothing is one the assertion would pass over.'
  );
}

/** The sub-expressions one identity is built from. */
function readableParts(node: ts.Node): readonly ts.Node[] {
  return pairedParts(node) ?? listParts(node);
}

/** The name a call names, whether it is called directly or off a receiver. */
function calleeNameOf(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return undefined;
}

/**
 * Reads one identity expression backwards, recording whether a compositing
 * function built it and whether the read ran out of things it could follow.
 */
function sliceInto(node: ts.Node, accumulator: Slice, seen: Set<ts.Node>): void {
  if (seen.has(node)) return;
  seen.add(node);
  if (ts.isCallExpression(node)) sliceCall(node, accumulator, seen);
  else if (ts.isIdentifier(node)) sliceIdentifier(node, accumulator, seen);
  else for (const part of readableParts(node)) sliceInto(part, accumulator, seen);
}

/** A call contributes its own name, its arguments, and any receiver it reads. */
function sliceCall(call: ts.CallExpression, accumulator: Slice, seen: Set<ts.Node>): void {
  const named = calleeNameOf(call);
  if (named !== undefined && COMPOSITING.has(named)) accumulator.compositing = true;
  for (const argument of call.arguments) sliceInto(argument, accumulator, seen);
  if (ts.isPropertyAccessExpression(call.expression)) {
    sliceInto(call.expression.expression, accumulator, seen);
  }
}

/** A name contributes whatever its declaration carries, or ends the read. */
function sliceIdentifier(node: ts.Identifier, accumulator: Slice, seen: Set<ts.Node>): void {
  if (node.text === 'undefined') return;
  const declaration = findDeclaration(node);
  if (declaration === undefined) {
    throw new Error(
      `rate-limit identity '${node.text}' binds to no declaration this walk can find — ` +
        'an identity it cannot read backwards is one it cannot attribute to a resolver.'
    );
  }
  const value = declaredValue(declaration);
  if (value === undefined) accumulator.unresolved = true;
  else sliceInto(value, accumulator, seen);
}

/** One counter spent in a flow: where, which entry, and the identity it counts. */
interface SpendSite {
  readonly at: string;
  readonly expression: string;
  readonly functionId: string;
  readonly ownerId: string;
  readonly identity: ts.Expression;
}

/** One layer of a spend, as written. */
interface SpentPair {
  readonly definition: string;
  readonly identity: ts.Expression;
}

/** The `{ definition, id }` one layer names, refusing a layer it cannot read. */
function layerPair(element: ts.Expression, where: string): SpentPair {
  if (!ts.isObjectLiteralExpression(element)) {
    throw new Error(`${where}: a consumeLayers layer this walk cannot read.`);
  }
  const read = (property: string): ts.Expression => {
    const found = element.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === property
    );
    if (found === undefined || !ts.isPropertyAssignment(found)) {
      throw new Error(`${where}: a consumeLayers layer naming no ${property}.`);
    }
    return found.initializer;
  };
  return { definition: read('definition').getText(element.getSourceFile()), identity: read('id') };
}

/** The `{ definition, id }` pairs one spend call names. */
function spentPairs(
  call: ts.CallExpression,
  primitive: SpendFunction,
  where: string
): readonly SpentPair[] {
  if (primitive === 'consume') {
    const [, definition, identity] = call.arguments;
    if (definition === undefined || identity === undefined) {
      throw new Error(`${where}: consume called without the entry and identity it spends.`);
    }
    return [{ definition: definition.getText(call.getSourceFile()), identity }];
  }
  const [, layers] = call.arguments;
  if (layers === undefined || !ts.isArrayLiteralExpression(layers)) {
    throw new Error(`${where}: consumeLayers takes a layer list this walk cannot read.`);
  }
  return layers.elements.map((element) => layerPair(element, where));
}

/** Every counter this Worker's flows spend, outside the primitive's own directory. */
const SPENDS: readonly SpendSite[] = (() => {
  const sites: SpendSite[] = [];
  for (const [file, source] of SOURCES) {
    const relative = path.relative(API_SRC, file);
    if (relative === PRIMITIVE_DIR || relative.startsWith(`${PRIMITIVE_DIR}${path.sep}`)) continue;
    const bound = spendBindings(source);
    if (bound.size === 0) continue;
    const visit = (node: ts.Node): void => {
      const primitive =
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          ? bound.get(node.expression.text)
          : undefined;
      if (primitive !== undefined && ts.isCallExpression(node)) {
        const at = locationOf(node, source);
        for (const pair of spentPairs(node, primitive, at)) {
          sites.push({
            at,
            expression: pair.definition,
            functionId: enclosingFunctionId(node, source),
            ownerId: owningFunctionId(node, source),
            identity: pair.identity,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return sites;
})();

/** One rate-limit spend whose identity composites the caller's network. */
interface CompositeSpend {
  readonly at: string;
  readonly expression: string;
  readonly functionId: string;
}

/** Whether one spend's identity is a composite. */
function isComposite(spend: SpendSite): boolean {
  const slice: Slice = { compositing: false, unresolved: false };
  sliceInto(spend.identity, slice, new Set<ts.Node>());
  if (slice.compositing) return true;
  if (!slice.unresolved) return false;
  return [...reach(spend.ownerId)].some((id) => {
    const name = NODES.get(id)?.name;
    return name !== undefined && COMPOSITING.has(name);
  });
}

/**
 * The spends whose identity is a composite: read from the identity expression
 * where the walk can follow it, and from the spending function's own reach
 * where it cannot, since an identity handed in as a parameter was built
 * somewhere this backward read does not go.
 */
const COMPOSITE_SPENDS: readonly CompositeSpend[] = SPENDS.filter((spend) =>
  isComposite(spend)
).map((spend) => ({
  at: spend.at,
  expression: spend.expression,
  functionId: spend.functionId,
}));

/** One line that resolves the caller's network, and which resolver it used. */
interface ResolverSite {
  readonly at: string;
  readonly kind: 'sentinel' | 'refusing';
  readonly functionId: string;
}

/** The local names one module binds to either resolver. */
function resolverBindings(source: ts.SourceFile): ReadonlyMap<string, 'sentinel' | 'refusing'> {
  const resolvers = new Map<string, 'sentinel' | 'refusing'>();
  for (const [local, canonical] of importedNames(source)) {
    const kind = RESOLVERS[canonical];
    if (kind !== undefined) resolvers.set(local, kind);
  }
  return resolvers;
}

/** Every line that resolves the caller's network. */
const RESOLVER_SITES: readonly ResolverSite[] = (() => {
  const sites: ResolverSite[] = [];
  for (const source of SOURCES.values()) {
    const resolvers = resolverBindings(source);
    if (resolvers.size === 0) continue;
    const visit = (node: ts.Node): void => {
      const kind =
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          ? resolvers.get(node.expression.text)
          : undefined;
      if (kind !== undefined) {
        sites.push({
          at: locationOf(node, source),
          kind,
          functionId: enclosingFunctionId(node, source),
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return sites;
})();

/**
 * Every sentinel resolution that reaches a network-composite spend. Pure over
 * all three inputs so the controls below can hand it a graph the tree does not
 * contain.
 */
function sentinelReachingComposite(
  sites: readonly ResolverSite[],
  spends: readonly CompositeSpend[],
  reachOf: (functionId: string) => ReadonlySet<string>
): readonly string[] {
  return sites
    .filter((site) => site.kind === 'sentinel')
    .flatMap((site) => {
      const reached = reachOf(site.functionId);
      return spends
        .filter((spend) => reached.has(spend.functionId))
        .map(
          (spend) =>
            `${site.at} resolves the caller network with the sentinel resolver and reaches ` +
            `${spend.at}, which spends ${spend.expression} on a caller-network composite`
        );
    });
}

/** The network-composite spends no refusing resolution reaches. */
function compositeSpendsWithoutRefusal(
  sites: readonly ResolverSite[],
  spends: readonly CompositeSpend[],
  reachOf: (functionId: string) => ReadonlySet<string>
): readonly string[] {
  const refused = new Set<string>();
  for (const site of sites) {
    if (site.kind !== 'refusing') continue;
    for (const id of reachOf(site.functionId)) refused.add(id);
  }
  return spends
    .filter((spend) => !refused.has(spend.functionId))
    .map((spend) => `${spend.at} spends ${spend.expression} on a caller-network composite`);
}

describe('a counter keyed on the caller network', () => {
  it('is never spent behind the sentinel resolver', () => {
    expect(sentinelReachingComposite(RESOLVER_SITES, COMPOSITE_SPENDS, reach)).toEqual([]);
  });

  it('is always spent behind the refusing one', () => {
    expect(compositeSpendsWithoutRefusal(RESOLVER_SITES, COMPOSITE_SPENDS, reach)).toEqual([]);
  });
});

describe('the walk', () => {
  it('finds composite spends and both resolvers, so it has a subject', () => {
    expect(COMPOSITE_SPENDS.length).toBeGreaterThan(0);
    expect(RESOLVER_SITES.filter((site) => site.kind === 'refusing').length).toBeGreaterThan(0);
    expect(RESOLVER_SITES.filter((site) => site.kind === 'sentinel').length).toBeGreaterThan(0);
  });

  it('reads the resolvers under the names they are still declared with', () => {
    const declarations = readFileSync(RESOLVER_MODULE, 'utf8');
    for (const name of Object.keys(RESOLVERS)) {
      expect(declarations).toContain(`export async function ${name}(`);
    }
  });

  it('reports every composite spend when the real refusals are read as sentinels', () => {
    const swapped = RESOLVER_SITES.map((site) => ({ ...site, kind: 'sentinel' as const }));
    const reported = sentinelReachingComposite(swapped, COMPOSITE_SPENDS, reach);
    expect(new Set(reported.map((line) => line.split(' reaches ')[1]))).toEqual(
      new Set(
        COMPOSITE_SPENDS.map(
          (spend) => `${spend.at}, which spends ${spend.expression} on a caller-network composite`
        )
      )
    );
  });

  it('reports a sentinel resolution that reaches a network-composite spend', () => {
    expect(
      sentinelReachingComposite(
        [{ at: 'slice/routes.ts:1', kind: 'sentinel', functionId: 'handler' }],
        [{ at: 'slice/domain/flow.ts:9', expression: 'KEYS.perNetwork', functionId: 'spender' }],
        () => new Set(['handler', 'spender'])
      )
    ).toEqual([
      'slice/routes.ts:1 resolves the caller network with the sentinel resolver and reaches ' +
        'slice/domain/flow.ts:9, which spends KEYS.perNetwork on a caller-network composite',
    ]);
  });

  it('passes a sentinel resolution that reaches no composite spend', () => {
    expect(
      sentinelReachingComposite(
        [{ at: 'slice/routes.ts:1', kind: 'sentinel', functionId: 'handler' }],
        [{ at: 'slice/domain/flow.ts:9', expression: 'KEYS.perNetwork', functionId: 'spender' }],
        () => new Set(['handler'])
      )
    ).toEqual([]);
  });

  it('reports a composite spend no refusing resolution reaches', () => {
    expect(
      compositeSpendsWithoutRefusal(
        [{ at: 'slice/routes.ts:1', kind: 'refusing', functionId: 'handler' }],
        [{ at: 'slice/domain/flow.ts:9', expression: 'KEYS.perNetwork', functionId: 'spender' }],
        () => new Set(['handler'])
      )
    ).toEqual(['slice/domain/flow.ts:9 spends KEYS.perNetwork on a caller-network composite']);
  });

  it('refuses an identity expression whose shape it cannot read', () => {
    const source = ts.createSourceFile(
      'probe.ts',
      'const spent = class {};',
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS
    );
    const declaration = source.statements[0];
    if (declaration === undefined || !ts.isVariableStatement(declaration)) {
      throw new Error('the probe did not parse as a variable statement.');
    }
    const initializer = declaration.declarationList.declarations[0]?.initializer;
    if (initializer === undefined) throw new Error('the probe carries no initializer.');
    expect(() => {
      sliceInto(initializer, { compositing: false, unresolved: false }, new Set<ts.Node>());
    }).toThrow(/a shape this walk cannot read/);
  });
});
