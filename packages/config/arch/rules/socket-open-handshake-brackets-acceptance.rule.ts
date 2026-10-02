import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath } from '../lib/paths.js';
import type { CallExpression, Node as SyntaxNode, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The open handshake brackets socket acceptance, and acceptance yields to
 * nothing.
 *
 * A Durable Object shell upgrades a socket in one ordered sequence: the
 * fallible half of the open handshake is awaited, the runtime accepts the
 * socket, the completing half runs, and the 101 returns. Two invariants ride
 * that one order, so one rule holds both: an edit that satisfies either alone
 * is precisely what a split pair would wave through.
 *
 * - Acceptance follows the fallible half. Acceptance is what puts the socket in
 *   the runtime's socket set, so setup that may reject the upgrade completes
 *   first; a rejection after acceptance strands a live socket the room never
 *   registered.
 * - Acceptance yields to nothing before the 101. From the accept call onward
 *   the socket is in the run fan-out, which enumerates that same socket set,
 *   and the completing half is what withholds it from the streams the client
 *   declared. An await in between lets the isolate yield, a queued run frame
 *   reaches the socket ahead of the withhold, and the client's cursor dedupe
 *   then discards the replay that answers it. Nothing fails and the socket
 *   keeps working: what is lost is one reconnect's replay, which is why the
 *   defect is invisible without a rule.
 *
 * Scope is the realtime source tree, located inside it by the accept call
 * rather than by file name, so a shell that is renamed or split is still
 * watched, and a tree that accepts no socket at all aborts the run instead of
 * passing over nothing. Shells cannot sit outside that tree while
 * `do-classes-live-in-realtime` holds, and a second shell in it is judged by
 * the same ordering: the invariants are properties of hibernated acceptance,
 * not of one room.
 *
 * What it can see is one body's syntax: the acceptance and both handshake
 * halves under the method name written at the call site, and lexical position
 * rather than control flow. That bounds it rather than listing its gaps. A
 * computed member access or a half moved into a helper in another file is not
 * the call it looks for. A preparation awaited in a branch acceptance does not
 * depend on still reads as preceding it. And a step that fails without being
 * awaited, a synchronous throw written after the acceptance, is the shape of
 * every other call, so the socket it strands is beyond any rule that does not
 * read types: what the sibling invariant is guarded against here is a fallible
 * half that is unawaited, missing, or on the wrong side of the acceptance.
 */

const RULE = 'socket-open-handshake-brackets-acceptance';
const fail = failWith(RULE);

/** The tree Durable Object shells live in. */
const REALTIME_SOURCE_TREE = 'packages/realtime/src/';

/** The hibernation call that puts a socket into the runtime's socket set. */
const ACCEPT = 'acceptWebSocket';

/** The fallible half of the open handshake, and the half that needs the socket accepted. */
const PREPARE = 'prepareOpen';
const COMPLETE = 'completeOpen';

const NOTHING_AWAITED =
  'An accepted socket is already in the run fan-out, so nothing may be awaited between the acceptance and the return of the upgrade: a yield there lets a queued run frame reach the socket before completeOpen withholds the streams it declared, and the client then discards the replay. Move the await ahead of the acceptance.';

const PREPARE_FIRST = `Setup that can reject the upgrade must finish before the socket is accepted, so a rejection leaves no accepted socket behind: await the ${PREPARE} half of the open handshake ahead of the acceptance.`;

const COMPLETE_IN_TURN = `Acceptance is what puts the socket in the run fan-out, so the ${COMPLETE} half of the open handshake must follow it in the same synchronous turn, withholding the socket from the streams it declared before a queued frame can reach it.`;

const NO_ACCEPTANCE = `the realtime source tree accepts no socket, so this rule watches nothing. Acceptance is its subject: if hibernated sockets are gone, delete the rule with them.`;

function isInScope(filePath: string): boolean {
  return filePath.includes(REALTIME_SOURCE_TREE) && !isTestFile(filePath);
}

/** Calls written as `<expression>.<method>(…)`. */
function methodCalls(container: SyntaxNode, method: string): CallExpression[] {
  return container.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee) && callee.getName() === method;
  });
}

/**
 * The body a node's own awaits suspend: its nearest enclosing function, or the
 * module when it has none. A callback written beside a statement runs on a turn
 * of its own, so what it awaits suspends nothing that statement is part of, and
 * what it calls happens on neither side of the statement's acceptance.
 */
function suspendingBody(node: SyntaxNode): SyntaxNode {
  return (
    node.getFirstAncestor((ancestor) => Node.isFunctionLikeDeclaration(ancestor)) ??
    node.getSourceFile()
  );
}

/**
 * Every suspension one body performs with the socket already accepted, which is
 * two positions rather than one. An await written after the accept call has
 * ended suspends with the socket in the set; so does an await whose own operand
 * contains the acceptance, since the call runs and the suspension follows it.
 * An await inside the accept call's own arguments is neither, because it
 * settles before the call it feeds.
 *
 * The following position is read off the `await` keyword, which is what the
 * language suspends on, so an await expression, an awaited iteration and an
 * awaited disposal are all one token. The wrapping position is an await
 * expression the accept call sits inside. Neither reading reports the other's
 * shape twice: a wrapping keyword always precedes the call it wraps.
 */
function suspensionsAfterAcceptance(accept: CallExpression, body: SyntaxNode): SyntaxNode[] {
  const wrapping = accept
    .getAncestors()
    .filter((ancestor) => Node.isAwaitExpression(ancestor) && suspendingBody(ancestor) === body);
  const following = body
    .getDescendantsOfKind(SyntaxKind.AwaitKeyword)
    .filter((token) => token.getStart() >= accept.getEnd() && suspendingBody(token) === body);
  return [...wrapping, ...following];
}

/** A call the enclosing body suspends on until it settles. */
function isAwaited(call: CallExpression): boolean {
  let node: SyntaxNode = call;
  while (Node.isParenthesizedExpression(node.getParentOrThrow())) {
    node = node.getParentOrThrow();
  }
  return Node.isAwaitExpression(node.getParentOrThrow());
}

/** The named handshake half this body performs, on the stated side of a position. */
function hasHalf(
  body: SyntaxNode,
  method: string,
  side: (call: CallExpression) => boolean
): boolean {
  return methodCalls(body, method).some((call) => suspendingBody(call) === body && side(call));
}

function violationsFor(accept: CallExpression, filePath: string): ArchViolation[] {
  const body = suspendingBody(accept);
  const acceptStart = accept.getStart();
  const at = (message: string): ArchViolation => ({
    file: filePath,
    line: accept.getStartLineNumber(),
    message,
  });
  const violations = suspensionsAfterAcceptance(accept, body).map((suspension) => ({
    file: filePath,
    line: suspension.getStartLineNumber(),
    message: NOTHING_AWAITED,
  }));
  if (!hasHalf(body, PREPARE, (call) => call.getStart() < acceptStart && isAwaited(call))) {
    violations.push(at(PREPARE_FIRST));
  }
  if (!hasHalf(body, COMPLETE, (call) => call.getStart() > acceptStart)) {
    violations.push(at(COMPLETE_IN_TURN));
  }
  return violations;
}

function scannedFiles(sourceFiles: readonly SourceFile[]): SourceFile[] {
  return sourceFiles.filter((file) => isInScope(relativePath(file)));
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const violations: ArchViolation[] = [];
    let accepted = 0;
    for (const file of scannedFiles(project.getSourceFiles())) {
      const filePath = relativePath(file);
      for (const accept of methodCalls(file, ACCEPT)) {
        accepted += 1;
        violations.push(...violationsFor(accept, filePath));
      }
    }
    if (accepted === 0) fail(NO_ACCEPTANCE);
    return violations;
  },
};

export default rule;
