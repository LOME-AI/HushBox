import { relativePath } from '../lib/paths.js';
import {
  coveredByPrefix,
  declarationsReferencing,
  declaredRouteClass,
  handlerNode,
  isApiSourceFile,
  namesInArguments,
  namesInNode,
  proofScopeDeclarations,
  referencesIdentifier,
  routeRegistrations,
  subtreeClassPrefixes,
} from '../lib/route-shapes.js';
import type { Node } from 'ts-morph';
import type { NamedDeclaration, RouteRegistration } from '../lib/route-shapes.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A guest-reachable route is `public`-classed **plus** an in-handler credential
 * gate, because the HTTP route-class matrix admits no link-guest principal. So
 * `routeClass('public')` alone does not say whether a route is anonymous or
 * credential-gated, and the pipeline authorizes neither — the handler does. This
 * rule makes the gate structural: a public route that is guest-reachable must
 * lexically resolve its caller.
 *
 * The cost of leaving it to review is measured, not hypothetical: a `public`
 * route shipped with one of its two gates silently omitted.
 *
 * # which public routes are in scope (and why scope never comes from the gate)
 *
 * Two signals, both readable without looking at whether a gate is present —
 * that independence is what keeps the rule falsifiable. Both are read from the
 * registration's arguments AND from the terminal handler the proof side
 * resolves, so hoisting a handler out of the registration cannot subtract a
 * route from the check:
 *  - the route reads a conversation id — from a `:conversationId` path param or
 *    from the request body — so the handler acts on one conversation for
 *    whoever asks. The body case is what puts the link-guest send in scope: its
 *    path names no conversation, and the id it runs against survives the
 *    deletion of any gate, which is precisely why it is a usable signal;
 *  - the registration names the link credential (`LINK_CREDENTIAL_HEADER` or the
 *    header string itself), anywhere in its middleware or its handler — a
 *    per-caller limiter keyed on the credential counts, and is exactly what
 *    keeps a route in scope after its gate call is deleted.
 *
 * A public route with neither signal is anonymous by design (a share id is its
 * own capability; a catalog read has no subject) and is passed.
 *
 * # what counts as proof (syntactic, by design)
 *
 * The terminal handler shows a caller-resolution gate: `resolveConversationCaller`
 * or `resolveMediaCaller`, either directly or through a helper that carries one
 * (conversations' `authorizeCaller`, chat's `resolveGuestSenderOrRefusal`),
 * declared in the registering module or imported by it from a sibling module of
 * the same slice's routes directory. Both bottom out in identity's
 * `resolveLinkGuestPrincipal`, which is the one place a link credential becomes
 * a principal; the conversation socket upgrade admits a guest only through a
 * single-use ticket minted behind that gate, and its helper resolves a session
 * through the same gate. Proof is read from identifier nodes, never from handler text: node
 * text carries comments, and a comment naming the gate is not an invocation of it.
 *
 * There is deliberately no exception list: a genuinely anonymous route that
 * needs a `:conversationId` would have to be reshaped rather than exempted,
 * because an exception list is the laundering hole this rule replaces.
 */

const GATE_NAMES = ['resolveConversationCaller', 'resolveMediaCaller'];

const CONVERSATION_PARAM = ':conversationId';

/** The names that mark a route as acting on one conversation, or on a guest. */
const CONVERSATION_SUBJECT = 'conversationId';
const CREDENTIAL_NAMES = ['LINK_CREDENTIAL_HEADER', 'x-link-auth'];

const REMEDY =
  "it must lexically invoke the shared gate (resolveConversationCaller / resolveMediaCaller), or a helper carrying one that is declared in this module or imported from a sibling module of this slice's routes directory";

function isPublic(registration: RouteRegistration, subtreePrefixes: string[]): boolean {
  const declared = declaredRouteClass(registration.call);
  if (declared !== undefined) return declared === 'public';
  return subtreePrefixes.some((prefix) => coveredByPrefix(prefix, registration.path));
}

/**
 * Why the route is guest-reachable, or `undefined` when it is not.
 *
 * The registration's arguments and the terminal handler are read together,
 * because a handler hoisted into a same-file `const` leaves its own names out of
 * the arguments entirely — the body-read signal and the credential signal would
 * both vanish on a refactor that moves the handler up a few lines, dropping the
 * route out of the check with no violation and no message. The proof side has
 * always resolved the handler; the subtracting side has to resolve it too.
 */
function scopeReason(
  registration: RouteRegistration,
  handler: Node | undefined
): string | undefined {
  if (registration.path.includes(CONVERSATION_PARAM)) {
    return `takes a ${CONVERSATION_PARAM} param`;
  }
  const names = namesInArguments(registration);
  if (handler !== undefined) {
    for (const name of namesInNode(handler)) names.add(name);
  }
  if (names.has(CONVERSATION_SUBJECT)) return 'reads a conversation id';
  return CREDENTIAL_NAMES.some((name) => names.has(name)) ? 'names the link credential' : undefined;
}

function checkRegistration(
  registration: RouteRegistration,
  subtreePrefixes: string[],
  declarations: NamedDeclaration[],
  filePath: string
): ArchViolation | undefined {
  if (!isPublic(registration, subtreePrefixes)) return undefined;
  const handler = handlerNode(registration);
  const reason = scopeReason(registration, handler);
  if (reason === undefined) return undefined;

  const route = `public ${registration.method.toUpperCase()} route '${registration.path}'`;
  if (handler === undefined) {
    return {
      file: filePath,
      line: registration.line,
      message: `${route} is guest-reachable but its handler is defined in another file — authorization cannot be proven at the route seam; declare the handler in this module, where ${REMEDY}.`,
    };
  }

  const gateHelpers = declarationsReferencing(declarations, GATE_NAMES, registration);
  if (referencesIdentifier(handler, GATE_NAMES) || referencesIdentifier(handler, gateHelpers)) {
    return undefined;
  }
  return {
    file: filePath,
    line: registration.line,
    message: `${route} ${reason} but never resolves its caller — ${REMEDY}.`,
  };
}

const rule: ArchRule = {
  name: 'public-routes-prove-authorization',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isApiSourceFile(sourceFile)) continue;
      const filePath = relativePath(sourceFile);
      const subtreePrefixes = subtreeClassPrefixes(sourceFile, 'public');
      const declarations = proofScopeDeclarations(sourceFile);
      for (const registration of routeRegistrations(sourceFile)) {
        const violation = checkRegistration(registration, subtreePrefixes, declarations, filePath);
        if (violation !== undefined) violations.push(violation);
      }
    }
    return violations;
  },
};

export default rule;
