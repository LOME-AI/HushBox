import { Node } from 'ts-morph';
import { EXEMPTION_MARKER, IDEMPOTENT, IDEMPOTENT_WRAPPERS } from '../lib/idempotency-seam.js';
import { relativePath } from '../lib/paths.js';
import {
  accessesMemberOf,
  calleeName,
  callsMemberNamed,
  coveredByPrefix,
  handlerNode,
  isApiSourceFile,
  MUTATING_METHODS,
  proofScopeDeclarations,
  referencesIdentifier,
  routeRegistrations,
  subtreePrefixesWhere,
} from '../lib/route-shapes.js';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { NamedDeclaration, RouteRegistration } from '../lib/route-shapes.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every mutating route — one registered under any of the router's verbs less
 * the read-only `get`/`options`, which is what {@link MUTATING_METHODS} derives
 * — that is NOT declared exempt must be statically proven to route its write
 * through the idempotency seam. This is the complement of
 * `idempotency-exemption-wrappers`: that rule
 * proves DECLARED-EXEMPT routes carry a wrapper; this one closes the blind
 * spot on the other side — a non-exempt mutating handler that never
 * reaches the idempotency mechanism (a bare `db.insert(...)` with no
 * `Idempotency-Key` accounting) fails the build.
 *
 * # what counts as proof (syntactic, by design)
 *
 * A non-exempt mutating handler passes when its terminal handler shows
 * one of three sanctioned idempotency mechanisms:
 * - `runMutation(...)` or `idempotent.<wrapper>` (the HTTP wrapper — the five
 *   wrappers are the only entry to `runMutation`, which accepts only
 *   `Idempotent<T>`);
 * - a wrapper helper that itself routes through one (e.g. conversations'
 *   `runByKey`), declared in the registering module or imported by it from a
 *   sibling module of the same slice's routes directory, and resolved by
 *   fix-point so a chain of indirection stays visible at the route seam;
 * - the ConversationRoom DO run-control seam (`.startRun`/`.stopRun`): a chat
 *   run's referee is the idempotency-key row claimed inside the DO, not an
 *   HTTP wrapper (ARCHITECTURE.md §Money & settlement, §Streaming & realtime).
 *
 * Every one of those reads is structural, never a text match: node text carries
 * comments and string literals, so a text-matched proof is satisfied by prose
 * naming the mechanism instead of invoking it — including in the helper
 * discovery pass, where a comment would promote an unrelated declaration to a
 * sanctioned wrapper helper and launder every route that calls it.
 *
 * # the exemption
 *
 * A route is skipped (its wrapper is the other rule's concern) when it carries
 * an inline `idempotencyExempt('<class>')` argument, or falls under a same-file
 * `.use('<prefix>', idempotencyExempt(...))` subtree declaration. The marker is
 * read structurally too, and for the sharper of the two reasons: a scope signal
 * that REMOVES routes from the checked set is a silent pass when a comment can
 * satisfy it, unlike a signal that adds them (a loud false positive). Both
 * signals here subtract, so neither may be read as text.
 *
 * A handler the registering module does not declare cannot be proven at the
 * route seam and is flagged — declare it there, routed through a wrapper helper
 * that module declares or imports from its slice's routes directory, so the
 * evidence stays inside the unit a reader opens (the same discipline the
 * exemption rule enforces).
 */

const RUN_MUTATION = 'runMutation';

/** The ConversationRoom DO run-control seam (the run-claim is the referee). */
const RUN_CONTROL_METHODS = ['startRun', 'stopRun'];

function declaresExemption(call: CallExpression): boolean {
  return call
    .getArguments()
    .some(
      (argument) => Node.isCallExpression(argument) && calleeName(argument) === EXEMPTION_MARKER
    );
}

/** Prefixes of every same-file `.use(path, idempotencyExempt(...))` subtree. */
function subtreeExemptionPrefixes(sourceFile: SourceFile): string[] {
  return subtreePrefixesWhere(sourceFile, declaresExemption);
}

/** Direct evidence of the HTTP idempotency wrapper. */
function hasWrapperEvidence(node: Node): boolean {
  return (
    referencesIdentifier(node, [RUN_MUTATION]) ||
    accessesMemberOf(node, IDEMPOTENT, IDEMPOTENT_WRAPPERS)
  );
}

/** One fix-point pass: adds any declaration that references a known helper;
 * returns whether the set grew. */
function growHelpers(declarations: NamedDeclaration[], helpers: Set<string>): boolean {
  let grew = false;
  for (const declaration of declarations) {
    if (helpers.has(declaration.name)) continue;
    if (referencesIdentifier(declaration.node, [...helpers])) {
      helpers.add(declaration.name);
      grew = true;
    }
  }
  return grew;
}

/**
 * In-scope identifiers whose declaration routes (transitively) through the HTTP
 * wrapper — the indirection helpers like `runByKey`. The loop runs to a
 * fix-point rather than one pass, so a chain of helpers is followed however deep
 * it goes.
 */
function wrapperHelperNames(declarations: NamedDeclaration[]): Set<string> {
  const helpers = new Set<string>(
    declarations.filter((declaration) => hasWrapperEvidence(declaration.node)).map((d) => d.name)
  );
  let growing = true;
  while (growing) growing = growHelpers(declarations, helpers);
  return helpers;
}

function hasProof(handler: Node, helpers: Set<string>): boolean {
  if (hasWrapperEvidence(handler) || callsMemberNamed(handler, RUN_CONTROL_METHODS)) return true;
  return referencesIdentifier(handler, [...helpers]);
}

function checkRegistration(
  registration: RouteRegistration,
  prefixes: string[],
  helpers: Set<string>,
  filePath: string
): ArchViolation | undefined {
  if (!MUTATING_METHODS.has(registration.method)) return undefined;
  if (declaresExemption(registration.call)) return undefined;
  if (prefixes.some((prefix) => coveredByPrefix(prefix, registration.path))) return undefined;

  const method = registration.method.toUpperCase();
  const line = registration.line;
  const handler = handlerNode(registration);
  if (handler === undefined) {
    return {
      file: filePath,
      line,
      message: `mutating ${method} route handler is defined in another file — idempotency routing cannot be proven at the route seam; declare the handler in this module, routed through a runMutation/idempotent.* wrapper helper declared here or imported from a sibling module of this slice's routes directory.`,
    };
  }
  if (hasProof(handler, helpers)) return undefined;
  return {
    file: filePath,
    line,
    message: `mutating ${method} route is neither idempotencyExempt nor routed through runMutation/idempotent.* (nor the run-claim seam) — every non-exempt mutating route must prove idempotency.`,
  };
}

const rule: ArchRule = {
  name: 'mutating-routes-prove-idempotency',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isApiSourceFile(sourceFile)) continue;
      const filePath = relativePath(sourceFile);

      const prefixes = subtreeExemptionPrefixes(sourceFile);
      const helpers = wrapperHelperNames(proofScopeDeclarations(sourceFile));
      for (const registration of routeRegistrations(sourceFile)) {
        const violation = checkRegistration(registration, prefixes, helpers, filePath);
        if (violation !== undefined) violations.push(violation);
      }
    }
    return violations;
  },
};

export default rule;
