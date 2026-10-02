import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import { calleeName, literalArgument, stringProperty, unwrap } from '../lib/route-shapes.js';
import type { CallExpression, ObjectLiteralExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A route declared storable is a route whose response a cache the caller does
 * not own may replay to a stranger, so the claim licensing that declaration is
 * that every caller receives the same bytes. Nothing establishes that claim
 * statically — a handler reads whatever it reads — but a rule can require that
 * a proof of it EXISTS, which is the shape `mutating-routes-prove-idempotency`
 * uses for the obligations it cannot evaluate either.
 *
 * The cost of leaving the claim to review is measured, not hypothetical:
 * `GET /chat/trial/remaining` derives its body from the caller's IP hash and is
 * `routeClass('public')`, and that class was read as evidence of
 * caller-invariance once already — it carried the cross-origin wildcard until
 * `apps/api/src/middleware/cors.ts` was reshaped to read the response instead.
 * Route class says a credential is not needed to REACH a route; it says nothing
 * about whose bytes come back.
 *
 * # scope, and why it comes from the declarations
 *
 * Every entry of `ROUTE_CACHE_POLICIES` whose `kind` is not the refusal is in
 * scope. Storability is read by EXCLUSION of the one kind that stores nowhere
 * rather than from a list of storable kinds, so a kind added to the vocabulary
 * arrives in scope demanding a proof: a rule that listed the storable kinds
 * would pass over the new one silently, and silence is the wrong side for a
 * declaration that authorizes replay.
 *
 * Nothing this rule cannot read is passed over — an absent or unreadable map, an
 * entry whose route or `kind` is not a literal, or a proof naming its route with
 * something other than a literal all throw. What went missing in each case is
 * the rule's own subject, so there is no violation to report and the throw is
 * the only signal available.
 *
 * # what counts as proof
 *
 * A call to {@link PROOF} naming the route key, in a test file inside the slice
 * tree, comparing the response bodies byte for byte. The helper is what makes
 * the proof one implementation rather than a hand-rolled comparison per route:
 * the caller variation lives in one place, so no proof can silently omit an arm
 * another proof tests, and widening the variation widens every proof at once —
 * where a copy that dropped an arm would be a caller input that copy never
 * tested.
 *
 * Read from the call expression and its literal argument, never from file text:
 * text carries comments, and a comment naming the helper is not a call to it —
 * the laundering hole every proof-obligation rule in this layer closes the same
 * way. A proof outside a test file is refused for the same reason: nothing runs
 * it, so it asserts nothing.
 *
 * The scope is the slice tree as a whole: {@link isSliceTestFile} asks where a
 * test file sits, never which slice serves the route it names, so a proof filed
 * beside the wrong slice still counts. That is deliberate rather than an
 * oversight — such a proof calls the helper with the real route key, so it
 * drives the real app and compares real bytes. It is misfiled, not fake, and
 * binding each proof to its own slice would buy tidiness, not safety.
 *
 * Excluding everything OUTSIDE that tree is the part that is load-bearing: the
 * helper's OWN test drives it against stand-in routes to prove what it refuses,
 * and every route key such a test names would otherwise read as discharged by a
 * file that never touched that route.
 *
 * There is deliberately no exception list. A route whose body genuinely varies
 * by caller is a route that may not be declared storable, so the remedy is the
 * declaration, never an exemption from proving it.
 *
 * The cost of that scope: a route served from outside the slice tree can carry
 * no proof this rule can see, so declaring one storable fails here until
 * {@link isSliceTestFile} is widened to wherever that route is served from. That
 * is the loud direction, and the widening belongs in the same change.
 *
 * # what a rule of this class cannot establish
 *
 * It proves a call EXISTS. It does not prove that call runs, nor that what runs
 * reaches the route the argument names: this reads syntax, and a route key
 * written at a call site is a claim of intent rather than evidence of behavior.
 * The proof's own body is where that is established, by review and by the
 * helper's tests; the rule guarantees only that there is a body to look at.
 */

/** Where every route's cacheability is declared. */
export const CACHE_POLICY_MAP_MODULE = 'apps/api/src/composition/route-cache-policy.ts';

const CACHE_POLICY_MAP = 'ROUTE_CACHE_POLICIES';

/** The one policy kind no cache may store, and so the one needing no proof. */
const REFUSAL_KIND = 'no-store';

/** The shared proof helper a colocated test calls. */
const PROOF = 'proveCallerInvariance';

const RULE = 'cacheable-routes-prove-caller-invariance';

const fail: (message: string) => never = failWith(RULE);

const REMEDY =
  `declare it '${REFUSAL_KIND}', or add a colocated test calling ${PROOF}('<route>', …) ` +
  'so two different callers are proven to receive identical bytes';

/** The policy map's object literal; every shape this rule cannot read throws. */
function readPolicyMap(project: Project): ObjectLiteralExpression {
  const file = sourceFileAt(project, CACHE_POLICY_MAP_MODULE);
  if (file === undefined) {
    fail(
      `'${CACHE_POLICY_MAP_MODULE}' names no file in the scanned tree. The cache-policy ` +
        "declarations are this rule's entire subject; without them it would report nothing " +
        'over nothing.'
    );
  }
  const initializer = unwrap(file.getVariableDeclaration(CACHE_POLICY_MAP)?.getInitializer());
  if (!Node.isObjectLiteralExpression(initializer)) {
    fail(
      `'${CACHE_POLICY_MAP}' in '${CACHE_POLICY_MAP_MODULE}' is no longer an object literal this ` +
        'rule can read, so no storable declaration is visible to it.'
    );
  }
  return initializer;
}

/** One storable declaration: the route it names, and where it is written. */
interface Storable {
  readonly routeKey: string;
  readonly line: number;
}

/** Where an unreadable map entry sits, for a message that can be acted on. */
function entryAt(property: Node): string {
  return `'${CACHE_POLICY_MAP}' in '${CACHE_POLICY_MAP_MODULE}' line ${String(
    property.getStartLineNumber()
  )}`;
}

/**
 * The storable route one map entry declares, or `undefined` when it declares
 * the refusal.
 */
function readStorable(property: Node): Storable | undefined {
  if (!Node.isPropertyAssignment(property)) {
    fail(
      `${entryAt(property)} is not a \`route: policy\` assignment this rule can read, so ` +
        'whatever it declares would be exempt from this check rather than by it.'
    );
  }
  const nameNode = property.getNameNode();
  if (!Node.isStringLiteral(nameNode)) {
    fail(
      `${entryAt(property)} names its route with something other than a string literal, so the ` +
        'route a proof would have to name cannot be resolved.'
    );
  }
  const policy = unwrap(property.getInitializer());
  if (!Node.isObjectLiteralExpression(policy)) {
    fail(
      `'${nameNode.getLiteralText()}' declares a policy this rule cannot read as an object ` +
        'literal, so whether it is storable is unknown.'
    );
  }
  const kind = stringProperty(policy, 'kind');
  if (kind === undefined) {
    fail(
      `'${nameNode.getLiteralText()}' declares no \`kind\` this rule can read as a literal. An ` +
        'entry it cannot classify is an entry it drops, and a dropped declaration is one ' +
        'nothing proves.'
    );
  }
  if (kind === REFUSAL_KIND) return undefined;
  return { routeKey: nameNode.getLiteralText(), line: property.getStartLineNumber() };
}

/** A test file inside the slice tree — the only place a proof counts. */
function isSliceTestFile(sourceFile: SourceFile): boolean {
  const filePath = relativePath(sourceFile);
  return filePath.includes('apps/api/src/slices/') && isTestFile(filePath);
}

/** The route key one call proves, or `undefined` when it is not a proof call. */
function provenRoute(call: CallExpression): string | undefined {
  if (calleeName(call) !== PROOF) return undefined;
  const routeKey = literalArgument(call, 0);
  if (routeKey === undefined) {
    fail(
      `'${relativePath(call.getSourceFile())}' line ${String(call.getStartLineNumber())} calls ` +
        `${PROOF} with something other than a string literal route, so the route it proves ` +
        'cannot be resolved and the declaration it was written for would still read as unproven.'
    );
  }
  return routeKey;
}

/** Every route key a proof call names, read off the call rather than the text. */
function provenRoutes(project: Project): Set<string> {
  const proven = new Set<string>();
  for (const sourceFile of project.getSourceFiles()) {
    if (!isSliceTestFile(sourceFile)) continue;
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const routeKey = provenRoute(call);
      if (routeKey !== undefined) proven.add(routeKey);
    }
  }
  return proven;
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const proven = provenRoutes(project);
    const violations: ArchViolation[] = [];
    for (const property of readPolicyMap(project).getProperties()) {
      const storable = readStorable(property);
      if (storable === undefined || proven.has(storable.routeKey)) continue;
      violations.push({
        file: CACHE_POLICY_MAP_MODULE,
        line: storable.line,
        message: `'${storable.routeKey}' is declared storable by a shared cache with no caller-invariance proof — ${REMEDY}.`,
      });
    }
    return violations;
  },
};

export default rule;
