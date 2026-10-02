import { Node } from 'ts-morph';
import { failWith } from '../lib/paths.js';
import { handlerNode, isApiSourceFile, routeRegistrations } from '../lib/route-shapes.js';
import type { Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

const RULE = 'route-handlers-stay-inferred';

/**
 * A route handler declares no return type. Hono builds the router's schema —
 * the `AppType` the typed client is generated from — out of each handler's
 * INFERRED return type, so an annotation replaces the response shape with
 * whatever the annotation says: `Promise<Response>` erases the body entirely,
 * and a `Handler<AppEnv>` binding erases the route. The client keeps compiling
 * against the widened type, and a field renamed on the server stops being a
 * build error, which is the drift the typed client exists to catch. The shape
 * to annotate is the function that BUILDS the body; the handler tail stays
 * inferred.
 *
 * The same trap sits one level up, on the factory that returns a slice's route
 * chain — `apps/api/src/slices/admin/routes.ts` records it where it lives, and
 * `apps/api/CLAUDE.md` states it. This rule stands over handlers only.
 *
 * WHY THIS LAYER. The verbs have to be read off `hono/router`'s own method set
 * rather than written down, and a handler reached by name has to be resolved
 * from its registration — neither is expressible as an ESLint selector, which
 * matches on syntax it can spell. Nothing else stands here either: the
 * repository requires explicit return types everywhere
 * (`docs/CODE-RULES.md` §"Type Safety"), and the `inferred-return-types` block
 * in the shared ESLint config releases `routes.ts` from that requirement
 * without forbidding the annotation. This is the documented exception to that
 * standing rule, and an exception nothing enforces is a convention.
 *
 * WHAT A HANDLER IS: the last argument of a route registration, read through
 * the shared route vocabulary. The verbs come with it — `routeRegistrations`
 * recognises the router's own method set, imported from `hono/router`, so a
 * verb the router gains is covered the day it does and no list here can fall
 * out of agreement with it.
 *
 * THERE IS NO EXEMPT SET, and deliberately none to maintain. A handler that
 * returns a bare `Response` (a stream, an HTML page) contributes `{}` to the
 * route's output and is CORRECT — but it is correct whether or not it says so,
 * and saying so buys nothing while widening every sibling status. So the
 * subject is the annotation, never the returned type, and the rule needs no
 * knowledge of which handlers return what. An enumeration of those handlers
 * was falsified three times in three days; this rule cannot carry one, because
 * it never asks the question.
 *
 * ABORTS on an empty subject set: a registration recogniser that has gone
 * blind and a repository with no annotated handler are otherwise the same
 * green.
 *
 * WHAT IT DOES NOT SEE. Representative rather than exhaustive:
 * - A handler declared in another module, or inside the factory that builds
 *   the chain. Resolution is same-file and top-level, so a hoisted handler in
 *   either position carries its annotation past the check.
 * - A registration under a non-literal path, which yields no registration to
 *   resolve a handler from.
 */

/** The return-type annotation a handler carries, or `undefined` when it states none. */
function annotationOf(node: Node): Node | undefined {
  if (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isFunctionDeclaration(node)
  ) {
    return node.getReturnTypeNode();
  }
  // A binding types itself or its initializer, and either widens the handler:
  // `const h: Handler<AppEnv> = …` states the return type through the alias.
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    return (
      node.getTypeNode() ?? (initializer === undefined ? undefined : annotationOf(initializer))
    );
  }
  return undefined;
}

/** Every annotated handler registered in one file. */
function annotatedHandlers(sourceFile: SourceFile): { violations: ArchViolation[]; seen: number } {
  const violations: ArchViolation[] = [];
  const registrations = routeRegistrations(sourceFile);
  for (const registration of registrations) {
    const handler = handlerNode(registration);
    const annotation = handler === undefined ? undefined : annotationOf(handler);
    if (annotation === undefined) continue;
    violations.push({
      file: sourceFile.getFilePath(),
      line: annotation.getStartLineNumber(),
      message:
        `The handler for ${registration.method} '${registration.path}' declares its return type ` +
        `as '${annotation.getText()}'. Hono derives the route schema from the handler's inferred ` +
        'return type, so the annotation widens it and blinds the typed client — annotate the ' +
        'function that builds the response body instead.',
    });
  }
  return { violations, seen: registrations.length };
}

const rule: ArchRule = {
  name: RULE,
  check(project: Project): ArchViolation[] {
    const fail: (message: string) => never = failWith(RULE);
    const violations: ArchViolation[] = [];
    let seen = 0;

    for (const sourceFile of project.getSourceFiles()) {
      if (!isApiSourceFile(sourceFile)) continue;
      const result = annotatedHandlers(sourceFile);
      violations.push(...result.violations);
      seen += result.seen;
    }

    if (seen === 0) {
      fail(
        'no route registration was found in the product Worker tree, so the rule stood over ' +
          'nothing. Either the tree moved out of the scanned scope or the registration ' +
          'recogniser in lib/route-shapes.ts no longer matches how routes are written.'
      );
    }
    return violations;
  },
};

export default rule;
