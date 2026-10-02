import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile, relativePath } from '../lib/paths.js';
import {
  REDIS_REGISTRY_OPERATIONS,
  calledMember,
  receiverTextNamesRedis,
} from '../lib/redis-calls.js';
import type { RedisRegistryOperation } from '../lib/redis-calls.js';
import type { BinaryExpression, CallExpression, SourceFile, VariableDeclaration } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A gate that reads a counter, compares it, and writes the stepped value back
 * is lossy: N callers racing through the read all observe the same value,
 * so the window admits `cap × concurrency` instead of `cap`. A cap beatable by
 * issuing requests in parallel is not a cap. `lib/rate-limit`'s single Lua
 * `INCR` closes the window because the increment IS the read.
 *
 * THE SPECIES THIS REFUSES: a Redis counter read, stepped by a constant, and
 * written back on the same path — the non-atomic round trip, in either
 * direction. The step by a constant is what makes the shape a counter, and it
 * is what keeps the two legitimate read-then-write shapes out. A read-through cache
 * writes back a value it fetched from elsewhere rather than the value it read
 * plus one. And a read-and-compare gate over an AMOUNT accumulator (settled
 * provider spend) writes nothing at all on the read path — its increment is a
 * separate atomic script fed a cost that does not exist at gate time — so what
 * races there is its read, not its counter.
 *
 * DIRECTION IS NOT PART OF THE SHAPE. A quota that counts DOWN — read
 * `remaining`, write `remaining - 1` — races identically: N callers all read 5,
 * all write 4, all admit. So a step by a numeric literal counts either way:
 * `x + 1`, `1 + x`, `x - 1`, `x++`, `x--`, `x += 1`, `x -= 1`. Subtraction
 * advances only its LEFT operand, because `100 - used` reflects the read
 * against a ceiling rather than stepping it.
 *
 * So the advance is tested for exactly that, both ends: it must step a value
 * DERIVED FROM THE READ, and it must REACH THE WRITE — carried there by a
 * binding, or written inline. Neither half alone is the shape. An arbitrary
 * `+ 1` in the body is not: a cache stamping `expiresAt: Date.now() + 30_000`
 * onto the value it fetched advances nothing it read. The derivation half is
 * what keeps that one out; a rule that red-lights it is pressure to weaken a
 * rule that is otherwise right.
 *
 * A step is by a NUMERIC LITERAL in each spelling read here — `+ 1`, `- 1`,
 * `++`, `--`, `+= 1`, `-= 1`. Four of those six have a right operand and the
 * literal test applies to it; `++` and `--` have no operand to read and are
 * literal-one steps by definition, so adding a literal test to their arm would
 * drop them rather than make the arms consistent.
 * `total += amountNanoUsd` is read the same way as
 * `total = stored.total + amountNanoUsd`: an accumulator fold, out of the
 * species, and out on the step test rather than on derivation. The two
 * spellings agreeing is the point — a formatter moves code between them.
 *
 * BOTH halves are TRANSITIVE and closed to a fixpoint over the function's local
 * bindings — a declaration or assignment whose right-hand side mentions a
 * tracked binding is itself one. The distance from the read to the `+ 1`, and
 * from the `+ 1` to the write, is free to write, so a check one hop deep on
 * either side is a check that hoisting a value onto its own line defeats.
 *
 * WHAT THIS WATCHES, named rather than left to be inferred from the code. Reads
 * are the registry helpers this rule classifies as reading a value —
 * `redisGet` / `redisGetDel` / `redisMGet`, a SUBSET of the registry rather
 * than the whole of it — or `get`,
 * `getdel`, `getset`, `mget`, `hget`, `hgetall`, `hmget` on a receiver whose
 * text contains "redis". Writes are `redisSet` / `redisSetNx`, or `set`,
 * `setex`, `psetex`, `getset`, `hset`, `hmset`, `hsetnx` on such a receiver. A
 * command may be reached by field or by string index (`redis['get']`), and its
 * name is matched case-insensitively, so node-redis's camelCase spellings
 * (`hGetAll`, `hSet`) are the same commands as the lowercase ones the
 * `@upstash/redis` client used here spells them with — reach that survives a
 * client swap rather than coverage of code that exists today. The hash
 * commands are in the set because a
 * hash field holding `{count, firstAttempt}` is the same window under a
 * different Redis type, and `getset` is in BOTH sets because it reads and
 * writes in one command.
 *
 * WHAT THIS DOES NOT SEE. REPRESENTATIVE, NOT EXHAUSTIVE — this is syntactic
 * analysis over source text, so the set of spellings is unbounded and no list
 * can close it. These are the shapes worth knowing about; a construct nobody
 * would write is out of scope rather than a gap:
 * - A counter that is not a Redis string or hash — a Postgres row advanced by
 *   `UPDATE … SET attempts = attempts + 1`, an in-process `Map`, or a sorted-set
 *   sliding window (`ZADD` + `ZCARD`), which counts without storing a count.
 * - A command named by a computed index (`redis[name](key)`), or reached off a
 *   receiver whose text does not contain "redis".
 * - Anything crossing a function boundary: derivation and carriage are by NAME
 *   and file-local, so a read value handed to a helper and stepped there
 *   breaks the chain. The same name-matching is loose in the other direction —
 *   a name is any identifier text, property keys included — so an unrelated
 *   binding reusing a tracked name joins the chain.
 * - Advancing by a computed constant, in either spelling: `count + step` or
 *   `count += step`, with `step` bound to `1`, and `count += 1n`. Only a
 *   numeric literal is read as a step, in either direction.
 * - A read-modify-write whose modification is neither `+` nor `-` by a numeric
 *   literal: a doubling (`count * 2`), a halving, or a value replaced outright
 *   by a computed expression. The same race, spelled with an operator this
 *   rule does not read as a step.
 */

/**
 * Where every registry helper stands with THIS rule, stated for all of them so
 * that a helper added to the registry cannot enter it unclassified — the
 * omission that left three of them known only to
 * `rate-limit-keys-use-the-primitive`, which scans the same files.
 *
 * `unwatched` is a statement about this rule, not about the helper: the round
 * trip refused here is a value read and the stepped value written back, and
 * this rule reads neither end through those three.
 */
const HELPER_ROLE: Readonly<Record<RedisRegistryOperation, 'read' | 'write' | 'unwatched'>> = {
  redisGet: 'read',
  redisGetDel: 'read',
  redisMGet: 'read',
  redisSet: 'write',
  redisSetNx: 'write',
  redisDel: 'unwatched',
  redisMGetEntry: 'unwatched',
  redisTtl: 'unwatched',
};

function helpersWithRole(role: 'read' | 'write'): Set<string> {
  return new Set(REDIS_REGISTRY_OPERATIONS.filter((operation) => HELPER_ROLE[operation] === role));
}

const READ_HELPERS = helpersWithRole('read');
const WRITE_HELPERS = helpersWithRole('write');
// `getset` reads and writes in one command, so it belongs to both families.
const READ_COMMANDS = new Set(['get', 'getdel', 'getset', 'mget', 'hget', 'hgetall', 'hmget']);
const WRITE_COMMANDS = new Set(['set', 'setex', 'psetex', 'getset', 'hset', 'hmset', 'hsetnx']);

const MESSAGE =
  "a read-then-write counter gate — the read and the step are not atomic, so parallel callers all pass one cap. Count through lib/rate-limit's `consume`, whose single INCR admits exactly maxAttempts under any concurrency.";

function isInScope(filePath: string): boolean {
  if (!filePath.includes('apps/api/src/')) return false;
  if (isTestFile(filePath)) return false;
  return !filePath.includes('apps/api/src/lib/rate-limit/');
}

/** A registry helper by name, or a Redis command on a client-looking receiver. */
function matchesRedisCall(
  call: CallExpression,
  helpers: Set<string>,
  commands: Set<string>
): boolean {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return helpers.has(callee.getText());
  const member = calledMember(call);
  if (member === undefined) return false;
  if (!commands.has(member.name.toLowerCase())) return false;
  return receiverTextNamesRedis(member.receiver);
}

/** An advance by a constant: the expression it advances, and where that value lands. */
interface Advance {
  readonly node: Node;
  /** The value being advanced — what must trace back to the read. */
  readonly source: Node;
}

function namesIn(node: Node): Set<string> {
  const names = new Set(node.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
  if (Node.isIdentifier(node)) names.add(node.getText());
  return names;
}

/** `state.count` → `state`; the binding a member chain ultimately advances. */
function baseName(node: Node): string | undefined {
  let current = node;
  while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
    current = current.getExpression();
  }
  return Node.isIdentifier(current) ? current.getText() : undefined;
}

function containsReadCall(node: Node): boolean {
  const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression);
  if (Node.isCallExpression(node)) calls.push(node);
  return calls.some((call) => matchesRedisCall(call, READ_HELPERS, READ_COMMANDS));
}

/** Whether an expression names any binding already known to carry the tracked value. */
function mentionsAny(node: Node, bindings: Set<string>): boolean {
  return [...namesIn(node)].some((name) => bindings.has(name));
}

/** An expression carrying the read's value — the read itself, or any binding already known to. */
function derivesFromRead(node: Node, bindings: Set<string>): boolean {
  return containsReadCall(node) || mentionsAny(node, bindings);
}

/** What makes an expression carry the value a closure is tracking. */
type Carries = (node: Node, bindings: Set<string>) => boolean;

function isAssignment(binary: BinaryExpression): boolean {
  const kind = binary.getOperatorToken().getKind();
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/** Adds every name, answering whether the set grew. */
function addNames(names: Set<string>, added: Iterable<string>): boolean {
  let grew = false;
  for (const name of added) {
    if (names.has(name)) continue;
    names.add(name);
    grew = true;
  }
  return grew;
}

/** One pass over `const x = <carrying>`; true when it learned a new name. */
function addDeclaredBindings(
  declarations: VariableDeclaration[],
  names: Set<string>,
  carries: Carries
): boolean {
  let grew = false;
  for (const declaration of declarations) {
    const initializer = declaration.getInitializer();
    if (initializer === undefined || !carries(initializer, names)) continue;
    grew = addNames(names, namesIn(declaration.getNameNode())) || grew;
  }
  return grew;
}

/** One pass over `x = <carrying>`; true when it learned a new name. */
function addAssignedBindings(
  assignments: BinaryExpression[],
  names: Set<string>,
  carries: Carries
): boolean {
  let grew = false;
  for (const assignment of assignments) {
    if (!carries(assignment.getRight(), names)) continue;
    const target = baseName(assignment.getLeft());
    if (target !== undefined) grew = addNames(names, [target]) || grew;
  }
  return grew;
}

/**
 * Every local binding that carries a tracked value, at any distance: the seeds,
 * and anything a later declaration or assignment builds out of one. Iterated to
 * a fixpoint, because the distance between one statement and the next is free to
 * write — `const previous = stored.count; const count = previous + 1;` is the
 * same counter as `const count = stored.count + 1;`, and `const state = { count
 * }; redisSet(…, state)` is the same write-back as `redisSet(…, { count })`.
 * A one-hop test on either side is a test that one ordinary binding defeats.
 */
function carryingBindings(body: Node, seeds: Iterable<string>, carries: Carries): Set<string> {
  const names = new Set(seeds);
  const declarations = body.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  const assignments = body
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter((binary) => isAssignment(binary));
  let grew = true;
  while (grew) {
    grew = addDeclaredBindings(declarations, names, carries);
    grew = addAssignedBindings(assignments, names, carries) || grew;
  }
  return names;
}

const STEP_ASSIGNMENTS = new Set<SyntaxKind>([
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
]);
const STEP_UNARIES = new Set<SyntaxKind>([SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken]);

/** `x + 1` / `1 + x` / `x - 1` / `x += 1` / `x -= 1` — the value the operator advances, if any. */
function binaryAdvance(binary: BinaryExpression): Advance | undefined {
  const operator = binary.getOperatorToken().getKind();
  // A compound assignment reads like its binary spelling: `total += amount` is
  // the accumulator fold that `total = stored.total + amount` is, not a step.
  if (STEP_ASSIGNMENTS.has(operator)) {
    if (Node.isNumericLiteral(binary.getRight())) return { node: binary, source: binary.getLeft() };
    return undefined;
  }
  // Subtraction advances only its LEFT operand: `100 - used` reflects the read
  // against a ceiling, which is a derived quantity rather than a step.
  if (operator === SyntaxKind.MinusToken) {
    if (Node.isNumericLiteral(binary.getRight())) return { node: binary, source: binary.getLeft() };
    return undefined;
  }
  if (operator !== SyntaxKind.PlusToken) return undefined;
  if (Node.isNumericLiteral(binary.getRight())) return { node: binary, source: binary.getLeft() };
  if (Node.isNumericLiteral(binary.getLeft())) return { node: binary, source: binary.getRight() };
  return undefined;
}

/** `x + 1`, `x - 1`, `x++`, `--x`, `x += 1`, `x -= 1` — advancing a value by a constant. */
function advancesIn(body: Node): Advance[] {
  const binaries = body
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .map((binary) => binaryAdvance(binary))
    .filter((advance) => advance !== undefined);
  const unary = [
    ...body.getDescendantsOfKind(SyntaxKind.PostfixUnaryExpression),
    ...body.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression),
  ]
    .filter((expression) => STEP_UNARIES.has(expression.getOperatorToken()))
    .map((expression) => ({ node: expression, source: expression.getOperand() }));
  return [...binaries, ...unary];
}

/** An advance made in place: `state.count++`, `state.remaining -= 1`. */
function mutatesInPlace(advance: Advance): boolean {
  const node = advance.node;
  if (Node.isPostfixUnaryExpression(node) || Node.isPrefixUnaryExpression(node)) return true;
  return Node.isBinaryExpression(node) && STEP_ASSIGNMENTS.has(node.getOperatorToken().getKind());
}

/** The binding an `x + 1` lands in, walking out to its declaration or assignment. */
function assignedCarrier(node: Node): string | undefined {
  for (let current = node.getParent(); current !== undefined; current = current.getParent()) {
    if (Node.isVariableDeclaration(current)) return baseName(current.getNameNode());
    if (
      Node.isBinaryExpression(current) &&
      current.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    ) {
      return baseName(current.getLeft());
    }
    if (Node.isFunctionLikeDeclaration(current)) return undefined;
  }
  return undefined;
}

/** The binding that receives the advanced value, when one does. */
function carrierOf(advance: Advance): string | undefined {
  if (mutatesInPlace(advance)) return baseName(advance.source);
  return assignedCarrier(advance.node);
}

function reachesWrite(advance: Advance, write: CallExpression, body: Node): boolean {
  if (contains(write, advance.node)) return true;
  const carrier = carrierOf(advance);
  if (carrier === undefined) return false;
  const carriers = carryingBindings(body, [carrier], mentionsAny);
  return write.getArguments().some((argument) => mentionsAny(argument, carriers));
}

/**
 * The write a read value reaches after being advanced — a counter's whole
 * round trip. A write without that trip is some other read-then-write shape.
 */
function lossyWriteIn(body: Node): CallExpression | undefined {
  const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression);
  const writes = calls.filter((call) => matchesRedisCall(call, WRITE_HELPERS, WRITE_COMMANDS));
  if (writes.length === 0) return undefined;
  if (!calls.some((call) => matchesRedisCall(call, READ_HELPERS, READ_COMMANDS))) return undefined;
  const bindings = carryingBindings(body, [], derivesFromRead);
  const advances = advancesIn(body).filter((advance) => derivesFromRead(advance.source, bindings));
  return writes.find((write) => advances.some((advance) => reachesWrite(advance, write, body)));
}

function contains(outer: Node, inner: Node): boolean {
  return outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();
}

function functionBodies(sourceFile: SourceFile): Node[] {
  return [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
  ];
}

function violationsIn(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const offenders = functionBodies(sourceFile).flatMap((body) => {
    const write = lossyWriteIn(body);
    return write === undefined ? [] : [{ body, write }];
  });
  return (
    offenders
      // Only the innermost offender: an enclosing factory that merely returns the
      // offending closure is not itself a second gate.
      .filter(
        (offender) =>
          !offenders.some((other) => other !== offender && contains(offender.body, other.body))
      )
      .map(({ write }) => ({
        file: filePath,
        line: write.getStartLineNumber(),
        message: MESSAGE,
      }))
  );
}

const rule: ArchRule = {
  name: 'no-lossy-counter-gate',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!isInScope(filePath)) continue;
      violations.push(...violationsIn(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
