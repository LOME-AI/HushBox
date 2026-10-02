import { METHOD_NAME_ALL_LOWERCASE, METHODS } from 'hono/router';
import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile, relativePath } from './paths.js';
import type {
  CallExpression,
  ImportDeclaration,
  ObjectLiteralExpression,
  SourceFile,
} from 'ts-morph';

/**
 * Syntactic vocabulary for reasoning about Hono route registrations, shared by
 * the route-facing arch rules. It reads no type information; the one thing it
 * resolves is an import's module specifier, which the harness posture in
 * `packages/config/arch/types.ts` permits.
 */

/**
 * The verbs a route is registered under: the router's own method set (`METHODS`
 * plus its all-methods spelling), which is what `routeRegistrations` recognises.
 *
 * Imported from `hono/router` rather than written out, so the set is the
 * router's own rather than a hand-maintained copy of it — a verb the router
 * gains cannot be missed here, and a list nobody can edit out of agreement is
 * the point of the import.
 */
const ROUTE_METHODS: ReadonlySet<string> = new Set([...METHODS, METHOD_NAME_ALL_LOWERCASE]);

/**
 * The read-only verbs. Every other registration verb mutates, including `all`,
 * which registers the mutating ones along with these.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['get', 'options']);

/**
 * The verbs whose routes mutate — DERIVED as the registration verbs that are
 * not read-only, never listed.
 *
 * The derivation runs in this direction because the containment is load-bearing
 * in one direction: a mutating verb missing from the registration recogniser is
 * a route `routeRegistrations` never yields, and a rule that checks mutating
 * routes goes silently blind rather than loudly wrong. Listing the mutating
 * verbs let a verb sit in {@link ROUTE_METHODS} unclassified; deriving them
 * means a verb added to the recogniser mutates unless it is declared safe, so
 * the failure lands on the loud side.
 */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(
  [...ROUTE_METHODS].filter((method) => !SAFE_METHODS.has(method))
);

/** One Hono route registration: a verb and the literal path registered under it. */
export interface RouteRegistration {
  readonly call: CallExpression;
  readonly method: string;
  readonly path: string;
  /** The line of the verb token itself, accurate inside a method chain. */
  readonly line: number;
}

/** A named top-level declaration and the node it spans. */
export interface NamedDeclaration {
  readonly name: string;
  readonly node: Node;
}

/** The name of a bare-identifier call (`routeClass(…)`), or `''`. */
export function calleeName(call: CallExpression): string {
  const callee = call.getExpression();
  return Node.isIdentifier(callee) ? callee.getText() : '';
}

/** The string-literal argument at the index, or `undefined` for any other node. */
export function literalArgument(call: CallExpression, index: number): string | undefined {
  const argument = call.getArguments()[index];
  return argument !== undefined && Node.isStringLiteral(argument)
    ? argument.getLiteralText()
    : undefined;
}

/**
 * Strips the type-only wrappers a declaration's initializer can carry — `as`
 * assertions and `satisfies` clauses, however they are stacked — so a rule
 * reading a declared map reaches the literal under them. A missing node passes
 * through, leaving a caller one absence to handle rather than two.
 */
export function unwrap(node: Node | undefined): Node | undefined {
  let current = node;
  while (Node.isAsExpression(current) || Node.isSatisfiesExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

/** The string a named property is assigned, or `undefined` for any other shape. */
export function stringProperty(object: ObjectLiteralExpression, name: string): string | undefined {
  const property = object.getProperty(name);
  if (!Node.isPropertyAssignment(property)) return undefined;
  const value = unwrap(property.getInitializer());
  return Node.isStringLiteral(value) ? value.getLiteralText() : undefined;
}

/** The member that carries its verb as an argument instead of as its own name. */
const ON = 'on';

/** The catch-all path, the one route path the router spells without a `/`. */
const WILDCARD = '*';

/**
 * The string literals an argument stands for: itself, or every literal element
 * of an array. Both of `on`'s leading arguments take either shape.
 */
function literalValues(argument: Node | undefined): string[] {
  if (Node.isStringLiteral(argument)) return [argument.getLiteralText()];
  if (!Node.isArrayLiteralExpression(argument)) return [];
  const values: string[] = [];
  for (const element of argument.getElements()) {
    if (Node.isStringLiteral(element)) values.push(element.getLiteralText());
  }
  return values;
}

/**
 * A route path literal. The `/` prefix is what separates a route from a
 * `.delete(table)` query builder, a `Map.delete(key)` or a `c.get('envUtils')`,
 * which take an identifier, an arbitrary expression, or a bare name; the
 * wildcard is the one route path written without it.
 */
function isRoutePath(literal: string): boolean {
  return literal.startsWith('/') || literal === WILDCARD;
}

/**
 * The verb/path pairs one call registers. `app.on('POST', '/x', h)` moves the
 * verb into argument 0 and the path to argument 1, and both arguments take a
 * list, so one `on` call can register several routes; every other verb is its
 * own member name with the path first.
 */
function registeredRoutes(
  call: CallExpression,
  member: string
): { method: string; path: string }[] {
  const isOn = member === ON;
  const verbs = isOn
    ? literalValues(call.getArguments()[0]).map((verb) => verb.toLowerCase())
    : [member];
  const paths = literalValues(call.getArguments()[isOn ? 1 : 0]).filter((path) =>
    isRoutePath(path)
  );
  return verbs
    .filter((method) => ROUTE_METHODS.has(method))
    .flatMap((method) => paths.map((path) => ({ method, path })));
}

/** Every route registration in the file, under every spelling of the call. */
export function routeRegistrations(sourceFile: SourceFile): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    for (const { method, path } of registeredRoutes(call, callee.getName())) {
      registrations.push({
        call,
        method,
        path,
        // The verb token, not the call's own start: inside a method chain a call
        // expression starts at the chain root, which would report every route in
        // a slice at the same line.
        line: callee.getNameNode().getStartLineNumber(),
      });
    }
  }
  return registrations;
}

/**
 * Every identifier name and string-literal value appearing inside the
 * registration's own arguments — path, middleware, handler.
 *
 * Read from the argument nodes rather than from text, for two reasons a rule
 * gets wrong silently. Inside a method chain a call expression starts at the
 * *chain root*, so `call.getText()` carries every sibling route in the chain and
 * would attribute a neighbour's evidence to this route. And node text carries
 * comments, so a route would be classified by prose about a different route.
 */
export function namesInArguments(registration: RouteRegistration): Set<string> {
  const names = new Set<string>();
  for (const argument of registration.call.getArguments()) {
    for (const name of namesInNode(argument)) names.add(name);
  }
  return names;
}

/**
 * Every identifier name and string-literal value in the node's own subtree.
 *
 * The unit {@link namesInArguments} is built from, and what a rule reads a
 * hoisted handler with: an argument that is a bare identifier carries none of
 * the names its declaration does, so a signal read from the arguments alone
 * disappears the moment a handler moves out of the registration.
 */
export function namesInNode(node: Node): Set<string> {
  const names = new Set<string>();
  for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
    names.add(identifier.getText());
  }
  for (const literal of node.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    names.add(literal.getLiteralText());
  }
  return names;
}

/**
 * The route class a registration (or a subtree `.use`) declares inline, read
 * from a direct `routeClass('<class>')` argument — at whatever position it sits.
 */
export function declaredRouteClass(call: CallExpression): string | undefined {
  for (const argument of call.getArguments()) {
    if (Node.isCallExpression(argument) && calleeName(argument) === 'routeClass') {
      return literalArgument(argument, 0);
    }
  }
  return undefined;
}

/** `'/shared/*'` and `'/shared/'` both normalize to `'/shared'`. */
export function subtreePrefix(raw: string): string {
  const starless = raw.endsWith('*') ? raw.slice(0, -1) : raw;
  return starless.endsWith('/') ? starless.slice(0, -1) : starless;
}

/**
 * Prefixes of every same-file `.use('<prefix>', …)` subtree declaration the
 * marker predicate accepts. The pipeline contract admits a wildcard `use` as an
 * alternative to a per-route marker, so a rule reading only inline markers would
 * leave that shape unclassified. A non-literal prefix cannot be resolved
 * syntactically and classifies nothing.
 */
export function subtreePrefixesWhere(
  sourceFile: SourceFile,
  declares: (call: CallExpression) => boolean
): string[] {
  const prefixes: string[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'use') continue;
    if (!declares(call)) continue;
    const raw = literalArgument(call, 0);
    if (raw !== undefined) prefixes.push(subtreePrefix(raw));
  }
  return prefixes;
}

/** Subtree prefixes declaring the given route class. */
export function subtreeClassPrefixes(sourceFile: SourceFile, cls: string): string[] {
  return subtreePrefixesWhere(sourceFile, (call) => declaredRouteClass(call) === cls);
}

export function coveredByPrefix(prefix: string, routePath: string): boolean {
  return routePath === prefix || routePath.startsWith(`${prefix}/`);
}

/**
 * The registration's terminal-handler node — the inline handler, or the same-file
 * declaration a handler identifier names. `undefined` when the handler is an
 * identifier declared outside this file: a shape no syntactic rule can follow,
 * and therefore one a rule must report rather than pass.
 */
export function terminalHandlerNode(call: CallExpression): Node | undefined {
  const handler = call.getArguments().at(-1);
  // An argument-less call has no handler to resolve, and falls out of the
  // identifier guard as `undefined` without a separate branch.
  if (!Node.isIdentifier(handler)) return handler;
  const sourceFile = handler.getSourceFile();
  const name = handler.getText();
  return sourceFile.getFunction(name) ?? sourceFile.getVariableDeclaration(name);
}

/** The terminal-handler node of a route registration. */
export function handlerNode(registration: RouteRegistration): Node | undefined {
  return terminalHandlerNode(registration.call);
}

/** Every named top-level function and variable declaration in the file. */
export function namedDeclarations(sourceFile: SourceFile): NamedDeclaration[] {
  const declarations: NamedDeclaration[] = [];
  for (const function_ of sourceFile.getFunctions()) {
    const name = function_.getName();
    if (name === undefined) continue;
    declarations.push({ name, node: function_ });
  }
  for (const variable of sourceFile.getVariableDeclarations()) {
    declarations.push({ name: variable.getName(), node: variable });
  }
  return declarations;
}

/**
 * Declarations that do not lexically enclose the registration under test.
 * Without that exclusion the factory function wrapping a slice's whole route
 * chain matches everything any of its routes carries, and a route could be
 * "proven" by a sibling route's evidence.
 *
 * Enclosure is a fact about one file: node offsets are per-file, so a
 * declaration in another module of the proof scope can span the registration's
 * offsets while enclosing nothing, and would lose its evidence to a coincidence
 * of position.
 */
function notEnclosing(
  declarations: NamedDeclaration[],
  registration: RouteRegistration
): NamedDeclaration[] {
  const sourceFile = registration.call.getSourceFile();
  const start = registration.call.getStart();
  const end = registration.call.getEnd();
  return declarations.filter(
    (declaration) =>
      !(
        declaration.node.getSourceFile() === sourceFile &&
        declaration.node.getStart() <= start &&
        declaration.node.getEnd() >= end
      )
  );
}

/** Those of the supplied declarations, non-enclosing, whose own node satisfies the predicate. */
export function declarationsWhere(
  declarations: NamedDeclaration[],
  matches: (node: Node) => boolean,
  registration: RouteRegistration
): string[] {
  return notEnclosing(declarations, registration)
    .filter((declaration) => matches(declaration.node))
    .map((declaration) => declaration.name);
}

/**
 * Whether the node references any of the names as an identifier.
 *
 * Read from identifier nodes rather than from node text, for the same reason
 * `namesInArguments` is: `getText()` carries comments. The choice is directional,
 * not positional: text-reading is safe only where a spurious match ENLARGES the
 * checked set, which is a loud false positive. A proof read from text is
 * satisfied by prose naming the gate instead of invoking it, and so is a scope
 * signal that SUBTRACTS — a commented exemption marker silently drops a route
 * from the check. Both directions of shrinkage must be read from the AST.
 */
export function referencesIdentifier(node: Node, names: readonly string[]): boolean {
  const wanted = new Set(names);
  return node
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => wanted.has(identifier.getText()));
}

/**
 * Whether the node accesses `<object>.<member>` for one of the members.
 *
 * Structural for the reason `referencesIdentifier` is: a text read accepts the
 * access written inside a comment. The receiver is compared against the access
 * expression's own text, which is an expression node and so cannot be prose; an
 * access whose receiver is itself a member chain (`deps.idempotent.byKey`) is not
 * matched, so a rule keyed on this reports it rather than accepting it.
 */
export function accessesMemberOf(node: Node, object: string, members: readonly string[]): boolean {
  const wanted = new Set(members);
  return node
    .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .some((access) => wanted.has(access.getName()) && access.getExpression().getText() === object);
}

/**
 * Whether the node calls a member named one of the names, on any receiver
 * (`deps.realtime(env).startRun(…)`). Structural for the same reason as above:
 * `\.\s*startRun\s*\(` in a comment is not a call.
 */
export function callsMemberNamed(node: Node, names: readonly string[]): boolean {
  const wanted = new Set(names);
  return node.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee) && wanted.has(callee.getName());
  });
}

/** Those of the supplied declarations, non-enclosing, that reference one of the names. */
export function declarationsReferencing(
  declarations: NamedDeclaration[],
  names: readonly string[],
  registration: RouteRegistration
): string[] {
  return declarationsWhere(declarations, (node) => referencesIdentifier(node, names), registration);
}

/** Non-test backend source under the api tree — where route rules apply. */
export function isApiSourceFile(sourceFile: SourceFile): boolean {
  const filePath = relativePath(sourceFile);
  return filePath.includes('apps/api/src/') && !isTestFile(filePath);
}

const SLICE_ROUTES_DIRECTORY = /(?:^|\/)(apps\/api\/src\/slices\/[^/]+\/routes)\//;

/**
 * The slice routes directory a path sits under, or `undefined` for a path
 * outside one. The slice name is inside what is returned, which is the whole
 * of the per-slice containment: two files answer with the same directory only
 * when they belong to the same slice, so a scope built from this answer can
 * never reach another slice's routes.
 *
 * A slice that still registers its routes in a single `routes.ts` module has no
 * such directory and answers `undefined`, leaving its routes proven where they
 * are registered.
 */
function sliceRoutesDirectory(filePath: string): string | undefined {
  return SLICE_ROUTES_DIRECTORY.exec(filePath)?.[1];
}

/**
 * The imported module's declarations, under the local names this import binds
 * them to. A type-only import binds no value, so it carries no proof that the
 * handler reaches the helper.
 */
function boundDeclarations(
  importDeclaration: ImportDeclaration,
  module_: SourceFile
): NamedDeclaration[] {
  if (importDeclaration.isTypeOnly()) return [];
  const localNames = new Map(
    importDeclaration
      .getNamedImports()
      .filter((named) => !named.isTypeOnly())
      .map((named) => [named.getName(), named.getAliasNode()?.getText() ?? named.getName()])
  );
  return namedDeclarations(module_).flatMap((declaration) => {
    const local = localNames.get(declaration.name);
    return local === undefined ? [] : [{ name: local, node: declaration.node }];
  });
}

/**
 * Declarations the module binds by name from a sibling module of its own slice's
 * routes directory.
 *
 * The binding is the whole of the widening's safety. Matched by name alone, a
 * module's own stub is proven by a sibling's real helper of that name — the
 * registering module declares `authorizeCaller` returning success, imports
 * nothing, and inherits the evidence of a helper it never calls. A name the
 * module declares itself cannot also be imported, so a local declaration keeps
 * being judged on its own evidence.
 *
 * A test module under the directory carries no proof — {@link isApiSourceFile}
 * withholds it — because evidence that only exists in a test proves nothing
 * about what ships.
 */
function importedProofDeclarations(sourceFile: SourceFile): NamedDeclaration[] {
  const directory = sliceRoutesDirectory(relativePath(sourceFile));
  if (directory === undefined) return [];
  return sourceFile.getImportDeclarations().flatMap((importDeclaration) => {
    const module_ = importDeclaration.getModuleSpecifierSourceFile();
    if (module_ === undefined || !isApiSourceFile(module_)) return [];
    if (sliceRoutesDirectory(relativePath(module_)) !== directory) return [];
    return boundDeclarations(importDeclaration, module_);
  });
}

/**
 * The declarations that may carry a route's proof: the registering module's
 * own, plus those it binds by name from a sibling module under the same slice's
 * routes directory.
 *
 * The evidence for a route may sit one module away, never one directory away:
 * the slice's routes directory is the unit a reader opens to answer whether a
 * route is guarded, so a helper the module imports from inside it has not
 * drifted from the route, while one outside it has.
 */
export function proofScopeDeclarations(sourceFile: SourceFile): NamedDeclaration[] {
  return [...namedDeclarations(sourceFile), ...importedProofDeclarations(sourceFile)];
}
