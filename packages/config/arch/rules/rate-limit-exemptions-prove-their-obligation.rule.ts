import { Node, SyntaxKind } from 'ts-morph';
import { isFetchCall } from '../lib/external-calls.js';
import { failWith, relativePath, sourceFileAt } from '../lib/paths.js';
import {
  calleeName,
  handlerNode,
  isApiSourceFile,
  routeRegistrations,
  stringProperty,
  unwrap,
} from '../lib/route-shapes.js';
import type {
  CallExpression,
  Identifier,
  ObjectLiteralExpression,
  Project,
  PropertyAccessExpression,
  SourceFile,
  SpreadAssignment,
} from 'ts-morph';
import type { RouteRegistration } from '../lib/route-shapes.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Doctrine (`docs/RATE-LIMITING.md` §"The exemption classes"): an
 * exemption is typed, and "each class carries a structural obligation a rule
 * checks". This is that rule for the classes whose obligation is a property of
 * ONE ROUTE — the verifier ordering on a signature-gated webhook, and the
 * absence of a store touch on a constant-cost route.
 *
 * An exemption is the one posture that puts no counter on a route, so the
 * obligation is the whole of what stands in a counter's place. A class whose
 * obligation nothing checks is a declaration that a route is bounded by
 * something, with no evidence that the something is there.
 *
 * # why the rule reads the declarations rather than a list of its own
 *
 * Scope is the posture map's own `exempt` entries, resolved to the
 * registrations they name. A rule carrying its own route list would go on
 * passing over a route that had been renamed, deleted, or re-declared, which is
 * the failure mode this whole phase exists to remove. Decay in the rule's own
 * subject is therefore loud rather than silent: nothing this rule cannot read
 * is passed over — an unreadable module, class list, map, or map entry throws —
 * and an `exempt` entry whose route the api tree registers nowhere is reported
 * against the map line that declares it. The one entry it skips is one whose
 * `kind` it read and which is not `exempt`.
 *
 * The class list is read from the vocabulary module rather than written here so
 * that adding a class cannot ship an unchecked exemption: the addition throws
 * until a checker lands beside it.
 *
 * # why a spread is followed rather than skipped
 *
 * The map merges the per-slice posture fragments, so most declarations reach it
 * through a spread rather than as entries written in it. Skipping a spread would
 * be the quiet version of the failure: the check would pass over every
 * declaration a fragment contributes and report nothing about any of them, which
 * reads exactly like an all-clear. So a spread is resolved to the object literal
 * it names — through the barrel that republishes it — and the entries there are
 * read as if they had been written in the map, each reported against the file and
 * line that declares it. A spread this rule cannot follow throws, for the same
 * reason an unreadable entry does.
 *
 * # what an obligation is read over
 *
 * Both classes read one surface: the registration's own argument nodes plus the
 * terminal handler they resolve to. Reading the handler alone left a store touch
 * in a middleware written as a registration argument unreported under
 * `signature-gated-webhook` while the identical touch reported under
 * `constant-cost` — one class blind at the insertion point an author reaches
 * for, the other not.
 *
 * The ceiling that survives, and it is shared rather than per class: only the
 * TERMINAL handler is resolved to a same-file declaration. A middleware hoisted
 * out of the registration leaves a bare identifier behind, and a store touch
 * inside one is read by neither class.
 */

/** Where the exemption classes are declared. */
export const POSTURE_VOCABULARY_MODULE = 'apps/api/src/lib/rate-limit/posture.ts';

/** The module the posture map is declared in. */
export const POSTURE_MAP_MODULE = 'apps/api/src/composition/rate-limit-posture.ts';

/** Where the factory a slice binds its carried postures through is declared. */
export const POSTURE_CAPABILITY_MODULE = 'apps/api/src/lib/rate-limit/capability.ts';

const EXEMPTION_LIST = 'RATE_LIMIT_EXEMPTIONS';
const POSTURE_MAP = 'ROUTE_POSTURES';
const MANIFEST_FACTORY = 'defineSliceManifest';
const POSTURE_BINDING_FACTORY = 'bindRoutePosture';

const RULE = 'rate-limit-exemptions-prove-their-obligation';

const fail: (message: string) => never = failWith(RULE);

/**
 * The injected verifier a signature-gated webhook is bounded by. Named rather
 * than derived: it is the dependency the composition root supplies to the
 * webhook slices, and a rename that leaves this behind fails every
 * signature-gated route at once — the loud direction.
 */
const VERIFIER_DEPENDENCY = 'webhookVerifier';
const VERIFY_MEMBER = 'verify';

/**
 * Request-scoped handles a store is reached through. `sideBand` sits with them
 * because deferring a store touch off the response is still a store touch, and
 * no `await` marks it.
 */
const STORE_HANDLES = new Set(['db', 'redis', 'cache', 'sideBand']);

/**
 * Members that run work whose result the handler does not wait for. The `void`
 * operator reads the same way, and is the fire-and-forget spelling that also
 * clears `no-floating-promises` — so it is read as a touch beside these rather
 * than left to that lint rule.
 */
const DEFERRING_MEMBERS = new Set(['then', 'waitUntil']);

/** The context member that reads the inbound request — never a store. */
const REQUEST = 'c.req';

/**
 * The request context, by the name every handler in this tree binds it under.
 *
 * Reading the receiver by name is what leaves a renamed context (`(ctx) =>
 * ctx.var.db`) unmatched. Widening it to any identifier receiver was tried and
 * rejected: `.get(key)` is a Map's spelling as much as Hono's, and an
 * unresolvable key has to count as a touch here, so the widened reading turns
 * `lookup.get(key)` over a module-level Map — genuinely constant cost — into a
 * red. A named lexical limit beats a false red.
 */
const CONTEXT = 'c';

/** The context members a request-scoped variable can be reached through. */
const VARS_MEMBER = 'var';
const GET_MEMBER = 'get';

/**
 * A module this rule cannot work without. The shared `assertNamedPathsExist`
 * states the same invariant, but it returns nothing, and a second lookup after
 * it would leave an arm no test can reach: what is missing here is the rule's
 * own subject, so the throw is the only signal available either way.
 */
function requiredFile(project: Project, repoPath: string): SourceFile {
  const file = sourceFileAt(project, repoPath);
  if (file === undefined) {
    fail(
      `'${repoPath}' names no file in the scanned tree. The rate-limit posture declarations are ` +
        "this rule's entire subject; without them it would report nothing over nothing."
    );
  }
  return file;
}

/** The string literals of a `const X = [...] as const` declaration. */
function readClassList(file: SourceFile): string[] {
  const initializer = unwrap(file.getVariableDeclaration(EXEMPTION_LIST)?.getInitializer());
  if (!Node.isArrayLiteralExpression(initializer)) {
    fail(
      `'${EXEMPTION_LIST}' in '${POSTURE_VOCABULARY_MODULE}' is no longer an array literal this ` +
        'rule can read, so the classes it must have a checker for are unknown and every ' +
        'exemption would pass unexamined.'
    );
  }
  return initializer.getElements().map((element) => {
    if (!Node.isStringLiteral(element)) {
      fail(
        `'${EXEMPTION_LIST}' in '${POSTURE_VOCABULARY_MODULE}' carries a member this rule ` +
          'cannot read as a class name. A class name it cannot read is a class it cannot ' +
          'demand an obligation for, so the addition would land unchecked.'
      );
    }
    return element.getLiteralText();
  });
}

/** The posture map's object literal. */
function readPostureMap(file: SourceFile): ObjectLiteralExpression {
  const initializer = unwrap(file.getVariableDeclaration(POSTURE_MAP)?.getInitializer());
  if (!Node.isObjectLiteralExpression(initializer)) {
    fail(
      `'${POSTURE_MAP}' in '${POSTURE_MAP_MODULE}' is no longer an object literal this rule can ` +
        'read, so no exemption declaration is visible to it.'
    );
  }
  return initializer;
}

/**
 * The factory a slice binds its counting postures through: the `kind` every
 * posture it produces carries, and the module a call has to resolve to before
 * it is read as one of them.
 */
interface BindingFactory {
  readonly kind: string;
  readonly module: SourceFile;
}

/**
 * The `kind` every posture the binding factory produces carries.
 *
 * A slice writes most of its postures as literals but binds the counting ones
 * through {@link POSTURE_BINDING_FACTORY}, whose call carries no `kind` to read.
 * Reading it off the factory's own return is what keeps that classification
 * honest, and it is the argument the class list is read from the vocabulary
 * module for: a factory that grows a second return, loses its literal, or is
 * renamed stops being readable and throws, so the day it can produce an
 * exemption is the day this rule says so rather than the day every route bound
 * through it quietly stops being examined.
 */
function readBoundPostureKind(file: SourceFile): string {
  const factory = file.getFunction(POSTURE_BINDING_FACTORY);
  if (factory === undefined) {
    fail(
      `'${POSTURE_CAPABILITY_MODULE}' declares no '${POSTURE_BINDING_FACTORY}', so the factory a ` +
        'slice binds its counting postures through cannot be read and every route bound through ' +
        'it would pass unexamined.'
    );
  }
  const returned = factory
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .map((statement) => unwrap(statement.getExpression()));
  const [posture, ...extra] = returned.filter((value) => Node.isObjectLiteralExpression(value));
  if (!Node.isObjectLiteralExpression(posture) || extra.length > 0) {
    fail(
      `'${POSTURE_BINDING_FACTORY}' in '${POSTURE_CAPABILITY_MODULE}' no longer returns exactly ` +
        'one posture literal this rule can read, so what the postures it binds declare is unknown ' +
        'and every route bound through it would pass unexamined.'
    );
  }
  const kind = stringProperty(posture, 'kind');
  if (kind === undefined) {
    fail(
      `'${POSTURE_BINDING_FACTORY}' in '${POSTURE_CAPABILITY_MODULE}' returns a posture whose ` +
        'kind this rule cannot read as a literal, so whether the routes it binds are exemptions ' +
        'is unknown.'
    );
  }
  return kind;
}

/** One `exempt` declaration: the route it names, its class, and where it is written. */
interface Exemption {
  readonly routeKey: string;
  readonly exemptionClass: string;
  readonly file: string;
  readonly line: number;
}

/**
 * One object literal the map's declarations are read out of — the map itself, or
 * a fragment a spread in it names — under the declaration and file a message
 * about it has to cite.
 */
interface PostureObject {
  readonly literal: ObjectLiteralExpression;
  readonly declaration: string;
  readonly file: string;
}

/** Where an unreadable entry sits, for a message that can be acted on. */
function entryAt(property: Node, source: PostureObject): string {
  const line = String(property.getStartLineNumber());
  return `'${source.declaration}' in '${source.file}' line ${line}`;
}

/**
 * The identifier a posture's call names, when the name it calls is the binding
 * factory's. Read off the callee rather than through `calleeName` because the
 * identifier is what {@link assertBoundThroughFactory} resolves the definition
 * from, and a name is not yet evidence that the call is the factory's.
 */
function factoryCallee(posture: Node | undefined): Identifier | undefined {
  if (!Node.isCallExpression(posture)) return undefined;
  const callee = posture.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === POSTURE_BINDING_FACTORY
    ? callee
    : undefined;
}

/**
 * The call is the factory's own, and not something else wearing its name.
 *
 * Classifying by the name alone leaves one door open: a fragment declaring its
 * own `bindRoutePosture` would have every posture it returns read as the real
 * factory's, so an exemption written behind that name would be passed over as a
 * counted route and nothing would examine its obligation — the silent
 * pass-over this whole rule refuses everywhere else. So every definition the
 * name resolves to must be the factory's; a name resolving nowhere is not it
 * either, and neither is one resolving to the factory AND to something local.
 */
function assertBoundThroughFactory(
  callee: Identifier,
  route: string,
  factory: BindingFactory
): void {
  const definitions = callee.getDefinitionNodes();
  const bound =
    definitions.length > 0 &&
    definitions.every((definition) => definition.getSourceFile() === factory.module);
  if (bound) return;
  fail(
    `'${route}' binds its posture through a '${POSTURE_BINDING_FACTORY}' this rule cannot ` +
      `resolve to the factory in '${POSTURE_CAPABILITY_MODULE}', so what that posture declares ` +
      'is unknown and an exemption written behind that name would pass unexamined.'
  );
}

/**
 * The `kind` one entry declares: read off the literal a slice writes, or taken
 * from the factory a slice binds through, whose call carries none to read.
 */
function readKind(posture: Node | undefined, route: string, factory: BindingFactory): string {
  const callee = factoryCallee(posture);
  if (callee !== undefined) {
    assertBoundThroughFactory(callee, route, factory);
    return factory.kind;
  }
  if (!Node.isObjectLiteralExpression(posture)) {
    fail(
      `'${route}' declares a posture this rule cannot read as an object literal or as a call to ` +
        `'${POSTURE_BINDING_FACTORY}', so whether it is an exemption is unknown.`
    );
  }
  const kind = stringProperty(posture, 'kind');
  if (kind === undefined) {
    fail(
      `'${route}' declares no \`kind\` this rule can read as a literal. An entry it cannot ` +
        'classify is an entry it drops, and a dropped exemption is one nothing examines.'
    );
  }
  return kind;
}

/**
 * The exemption one map entry declares, or `undefined` when it declares a
 * posture that is not one. Every shape this rule cannot read throws instead.
 */
function readExemption(
  property: Node,
  source: PostureObject,
  factory: BindingFactory
): Exemption | undefined {
  if (!Node.isPropertyAssignment(property)) {
    fail(
      `${entryAt(property, source)} is not a \`route: posture\` assignment this rule can read, so ` +
        'whatever it declares would be exempt from this check rather than by it.'
    );
  }
  const nameNode = property.getNameNode();
  if (!Node.isStringLiteral(nameNode)) {
    fail(
      `${entryAt(property, source)} names its route with something other than a string literal, ` +
        'so the registration it declares a posture for cannot be resolved.'
    );
  }
  const route = nameNode.getLiteralText();
  const posture = unwrap(property.getInitializer());
  if (readKind(posture, route, factory) !== 'exempt') return undefined;
  const exemptionClass = Node.isObjectLiteralExpression(posture)
    ? stringProperty(posture, 'exemption')
    : undefined;
  if (exemptionClass === undefined) {
    fail(
      `'${route}' is declared exempt with an exemption this rule cannot read as a literal ` +
        'class name, so no obligation can be selected for it.'
    );
  }
  return {
    routeKey: route,
    exemptionClass,
    file: source.file,
    line: property.getStartLineNumber(),
  };
}

/**
 * The object literal a spread contributes, resolved through whatever republishes
 * it — a slice barrel's `export { X } from './…'` reaches the fragment's own
 * declaration, which is how the map names a fragment without importing its file.
 *
 * `enclosing` carries the literals already being read, so a spread that leads
 * back into one of them throws instead of recurring forever.
 */
function spreadSource(
  spread: SpreadAssignment,
  source: PostureObject,
  enclosing: readonly ObjectLiteralExpression[]
): PostureObject {
  const expression = spread.getExpression();
  if (!Node.isIdentifier(expression)) {
    fail(
      `${entryAt(spread, source)} spreads '${expression.getText()}', which names no declaration ` +
        'this rule can follow, so the postures it contributes would be exempt from this check ' +
        'rather than by it.'
    );
  }
  const name = expression.getText();
  const [declaration] = expression.getDefinitionNodes();
  if (!Node.isVariableDeclaration(declaration)) {
    fail(
      `${entryAt(spread, source)} spreads '${name}', which resolves to no variable in the ` +
        'scanned tree, so the postures it contributes cannot be read.'
    );
  }
  const literal = unwrap(declaration.getInitializer());
  if (!Node.isObjectLiteralExpression(literal)) {
    fail(
      `${entryAt(spread, source)} spreads '${name}', whose declaration this rule cannot read as ` +
        'an object literal, so the postures it contributes are invisible to it.'
    );
  }
  if (enclosing.includes(literal)) {
    fail(
      `${entryAt(spread, source)} spreads '${name}', a map this rule is already reading — ` +
        'following it would not terminate.'
    );
  }
  return { literal, declaration: name, file: relativePath(literal.getSourceFile()) };
}

/** Every exemption one object literal declares, following the spreads it carries. */
function declaredExemptions(
  source: PostureObject,
  enclosing: readonly ObjectLiteralExpression[],
  factory: BindingFactory
): Exemption[] {
  const within = [...enclosing, source.literal];
  return source.literal.getProperties().flatMap((property) => {
    if (Node.isSpreadAssignment(property)) {
      return declaredExemptions(spreadSource(property, source, within), within, factory);
    }
    const exemption = readExemption(property, source, factory);
    return exemption === undefined ? [] : [exemption];
  });
}

function readExemptions(file: SourceFile, factory: BindingFactory): Exemption[] {
  return declaredExemptions(
    { literal: readPostureMap(file), declaration: POSTURE_MAP, file: POSTURE_MAP_MODULE },
    [],
    factory
  );
}

/** A registration under the manifest that mounts it, keyed as the router reports it. */
interface MountedRoute {
  readonly registration: RouteRegistration;
  readonly file: string;
}

/** `'/updates'` + `'/current'`; a manifest's own root route registers as `'/'`. */
function mountedPath(basePath: string, routePath: string): string {
  return routePath === '/' ? basePath : `${basePath}${routePath}`;
}

/** The mount prefix a manifest call declares, or `undefined` for any other call. */
function manifestBasePath(call: CallExpression): string | undefined {
  if (calleeName(call) !== MANIFEST_FACTORY) return undefined;
  const options = unwrap(call.getArguments()[0]);
  return Node.isObjectLiteralExpression(options) ? stringProperty(options, 'basePath') : undefined;
}

/** Whether the registration is written inside the manifest call that mounts it. */
function enclosedBy(registration: RouteRegistration, call: CallExpression): boolean {
  return (
    registration.call.getStart() >= call.getStart() && registration.call.getEnd() <= call.getEnd()
  );
}

function collectMountedRoutes(sourceFile: SourceFile, routes: Map<string, MountedRoute>): void {
  const file = relativePath(sourceFile);
  const registrations = routeRegistrations(sourceFile);
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const basePath = manifestBasePath(call);
    if (basePath === undefined) continue;
    for (const registration of registrations.filter((each) => enclosedBy(each, call))) {
      const key = `$${registration.method} ${mountedPath(basePath, registration.path)}`;
      routes.set(key, { registration, file });
    }
  }
}

/**
 * Every route the api tree registers, keyed `${method} ${path}` — read through
 * the manifest that supplies the mount prefix, because a slice's registration
 * carries only the path below it.
 */
function mountedRoutes(project: Project): Map<string, MountedRoute> {
  const routes = new Map<string, MountedRoute>();
  for (const sourceFile of project.getSourceFiles()) {
    if (isApiSourceFile(sourceFile)) collectMountedRoutes(sourceFile, routes);
  }
  return routes;
}

/** An I/O touch found in a handler, and how to describe it. */
interface StoreTouch {
  readonly node: Node;
  readonly what: string;
}

/** Whether the awaited expression is a read of the inbound request. */
function isRequestRead(node: Node | undefined): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const receiver = callee.getExpression().getText();
  return receiver === REQUEST || receiver.startsWith(`${REQUEST}.`);
}

function awaitTouch(node: Node): StoreTouch | undefined {
  if (!Node.isAwaitExpression(node) || isRequestRead(node.getExpression())) return undefined;
  return { node, what: 'awaits work that is not a read of the inbound request' };
}

/**
 * The property names an object binding pattern takes off its source, or
 * `undefined` when it cannot be read as a fixed set of them — a rest element
 * binds whatever is left, and a computed member names something this rule
 * cannot evaluate.
 */
function boundPropertyNames(pattern: Node): string[] | undefined {
  if (!Node.isObjectBindingPattern(pattern)) return undefined;
  const names: string[] = [];
  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken() !== undefined) return undefined;
    const property = element.getPropertyNameNode() ?? element.getNameNode();
    if (Node.isStringLiteral(property)) names.push(property.getLiteralText());
    else if (Node.isIdentifier(property)) names.push(property.getText());
    else return undefined;
  }
  return names;
}

/**
 * The request variables one read of the context names, or `undefined` when this
 * rule cannot tell which ones it names.
 *
 * Both spellings resolve here — `c.var` and `c.get(…)` reach the same bag, and
 * the repository writes both (`c.get('envUtils')` in the session pipeline
 * stage) — so a check that knew only one would pass a handler that used the
 * other. Every read that resolves to no fixed set of names is treated as
 * reaching all of them: aliasing the bag into a local, handing it somewhere, or
 * indexing it by a computed key hides exactly the handle being looked for, and
 * that failure has to land on the loud side.
 */
function namedContextVariables(access: PropertyAccessExpression): string[] | undefined {
  const parent = access.getParent();
  if (access.getName() === GET_MEMBER) {
    if (!Node.isCallExpression(parent) || parent.getExpression() !== access) return undefined;
    const key = parent.getArguments()[0];
    return Node.isStringLiteral(key) ? [key.getLiteralText()] : undefined;
  }
  if (Node.isPropertyAccessExpression(parent)) return [parent.getName()];
  if (Node.isElementAccessExpression(parent)) {
    const key = parent.getArgumentExpression();
    return Node.isStringLiteral(key) ? [key.getLiteralText()] : undefined;
  }
  if (Node.isVariableDeclaration(parent)) return boundPropertyNames(parent.getNameNode());
  return undefined;
}

function handleTouch(node: Node): StoreTouch | undefined {
  if (!Node.isPropertyAccessExpression(node)) return undefined;
  const member = node.getName();
  if (member !== VARS_MEMBER && member !== GET_MEMBER) return undefined;
  if (node.getExpression().getText() !== CONTEXT) return undefined;
  const named = namedContextVariables(node);
  if (named === undefined) {
    return { node, what: `reads '${CONTEXT}.${member}' in a shape that hides which variable` };
  }
  const handle = named.find((name) => STORE_HANDLES.has(name));
  return handle === undefined ? undefined : { node, what: `reaches the '${handle}' handle` };
}

function fetchTouch(node: Node): StoreTouch | undefined {
  if (!Node.isCallExpression(node) || !isFetchCall(node)) return undefined;
  return { node, what: 'calls fetch' };
}

function deferredTouch(node: Node): StoreTouch | undefined {
  if (Node.isVoidExpression(node)) return { node, what: 'discards an expression with `void`' };
  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !DEFERRING_MEMBERS.has(callee.getName())) {
    return undefined;
  }
  return { node, what: `defers work through '${callee.getName()}'` };
}

/**
 * What the node says the handler touches, or `undefined`.
 *
 * Every reading is structural rather than textual, for the reason
 * `route-shapes` states: node text carries comments, and a signal that
 * SUBTRACTS a route from a check must never be satisfiable by prose. Here the
 * direction is the same one inverted — a signal that ADDS a violation must not
 * be produced by prose either, or a comment mentioning `c.var.db` fails a route
 * that never touches it.
 */
function storeTouch(node: Node): StoreTouch | undefined {
  return awaitTouch(node) ?? handleTouch(node) ?? fetchTouch(node) ?? deferredTouch(node);
}

/**
 * Every store touch inside the subtrees, in source order. The roots themselves
 * are registration arguments and a resolved handler declaration — a function,
 * a marker call or a declaration node, never a touch — so only their
 * descendants are read.
 */
function storeTouches(roots: readonly Node[]): StoreTouch[] {
  const touches: StoreTouch[] = [];
  for (const root of roots) {
    root.forEachDescendant((node) => {
      const touch = storeTouch(node);
      if (touch !== undefined) touches.push(touch);
    });
  }
  return touches.toSorted((a, b) => a.node.getStart() - b.node.getStart());
}

/**
 * The handler's first call to the injected webhook verifier: a `.verify(…)`
 * whose receiver expression names {@link VERIFIER_DEPENDENCY} somewhere inside
 * it, which is how the composition root's dependency is reached today
 * (`deps.webhookVerifier(c.env).verify(…)`). A receiver that is the bare
 * identifier — the verifier hoisted into a local — is not matched, so that
 * refactor reports rather than passes.
 */
function verifierCall(handler: Node): Node | undefined {
  return handler.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== VERIFY_MEMBER) {
      return false;
    }
    return callee
      .getExpression()
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .some((identifier) => identifier.getText() === VERIFIER_DEPENDENCY);
  });
}

/**
 * `signature-gated-webhook`: verification precedes any I/O the ROUTE ITSELF
 * performs and IS the bound. Verification runs over the raw body, so reads of
 * the inbound request are the awaits allowed to come before it.
 *
 * The handler's own touches are filtered by position against the verifier call.
 * Everything else the registration contributes is not: a middleware argument is
 * entered before the handler, so a store touch in one is not ordered by the line
 * it sits on — a hoisted handler puts the whole argument list below the verifier.
 * What a middleware does after `next()` returns is read the same way, which
 * reports on the loud side.
 */
function checkSignatureGatedWebhook(handler: Node, scanned: readonly Node[]): string | undefined {
  const verifier = verifierCall(handler);
  if (verifier === undefined) {
    return (
      `never invokes the injected '${VERIFIER_DEPENDENCY}' — a '.${VERIFY_MEMBER}(…)' call on it ` +
      "is the whole of what bounds the route in a counter's place"
    );
  }
  const start = verifier.getStart();
  const early =
    storeTouches(scanned.filter((node) => node !== handler))[0] ??
    storeTouches([handler]).find((touch) => touch.node.getEnd() <= start);
  return early === undefined ? undefined : `${early.what} before its signature verifier runs`;
}

/** `constant-cost`: the handler touches no database, Redis, bucket, or `fetch`. */
function checkConstantCost(scanned: readonly Node[]): string | undefined {
  return storeTouches(scanned)[0]?.what;
}

/**
 * What one exemption class must show, given the route's terminal handler and
 * the wider set of nodes the registration contributes. Returns the sentence
 * completing "…but it <verdict>", or `undefined` when the obligation holds.
 */
type Obligation = (handler: Node, scanned: readonly Node[]) => string | undefined;

/**
 * A `Map` rather than an object literal so lookup is membership and nothing
 * else: `'toString' in {…}` is true, so an object-literal table would answer a
 * declared class named after an inherited member with a function that is not an
 * obligation, and the class would ship looking checked.
 */
const OBLIGATIONS = new Map<string, Obligation>([
  ['signature-gated-webhook', checkSignatureGatedWebhook],
  ['constant-cost', (_handler, scanned) => checkConstantCost(scanned)],
]);

/**
 * The registration's own argument nodes plus the handler they resolve to. Read
 * as separate roots rather than through the registration call, which inside a
 * method chain starts at the chain root and so spans the routes registered
 * before it — judging one route by another's body. The handler is appended so
 * that hoisting it into a same-file `const` subtracts nothing from the check.
 */
function scannedNodes(registration: RouteRegistration, handler: Node): Node[] {
  const argumentNodes: Node[] = [...registration.call.getArguments()];
  return argumentNodes.includes(handler) ? argumentNodes : [...argumentNodes, handler];
}

function checkExemption(
  exemption: Exemption,
  routes: Map<string, MountedRoute>
): ArchViolation | undefined {
  const label = `'${exemption.routeKey}' is exempt as ${exemption.exemptionClass}`;
  const mounted = routes.get(exemption.routeKey);
  if (mounted === undefined) {
    return {
      file: exemption.file,
      line: exemption.line,
      message: `${label}, but the api tree registers no route under that key — the obligation stands over nothing.`,
    };
  }
  const handler = handlerNode(mounted.registration);
  if (handler === undefined) {
    return {
      file: mounted.file,
      line: mounted.registration.line,
      message: `${label}, but its handler is defined in another file — the obligation cannot be proven at the route seam; inline it.`,
    };
  }
  const obligation = OBLIGATIONS.get(exemption.exemptionClass);
  if (obligation === undefined) {
    fail(
      `'${exemption.routeKey}' declares the exemption class '${exemption.exemptionClass}', which ` +
        'this rule has no obligation for — the route would be exempted from counting and checked ' +
        'for nothing.'
    );
  }
  const verdict = obligation(handler, scannedNodes(mounted.registration, handler));
  return verdict === undefined
    ? undefined
    : {
        file: mounted.file,
        line: mounted.registration.line,
        message: `${label}, but it ${verdict}.`,
      };
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const vocabulary = requiredFile(project, POSTURE_VOCABULARY_MODULE);
    const map = requiredFile(project, POSTURE_MAP_MODULE);
    for (const exemptionClass of readClassList(vocabulary)) {
      if (OBLIGATIONS.has(exemptionClass)) continue;
      fail(
        `'${exemptionClass}' is a declared exemption class with no obligation checker here, so a ` +
          'route declaring it would be exempted from counting and checked for nothing.'
      );
    }
    const capability = requiredFile(project, POSTURE_CAPABILITY_MODULE);
    const factory: BindingFactory = {
      kind: readBoundPostureKind(capability),
      module: capability,
    };
    const routes = mountedRoutes(project);
    const violations: ArchViolation[] = [];
    for (const exemption of readExemptions(map, factory)) {
      const violation = checkExemption(exemption, routes);
      if (violation !== undefined) violations.push(violation);
    }
    return violations;
  },
};

export default rule;
