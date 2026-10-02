import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, SourceFile, TemplateExpression } from 'ts-morph';

/**
 * How a Redis call is written, on each side the rules scan: the named registry
 * helpers, the client member call, and the Lua dispatch inside an embedded
 * script literal. It says nothing about what any of them MEANS — the counting
 * species lives in `event-counting.ts`, and the read-then-write species lives in
 * `no-lossy-counter-gate`'s own header.
 *
 * The rules reading these call sites do not all refuse the same thing — which
 * rules they are is the import graph's answer, not a roster here — so a
 * spelling one copy of a reader accepts and another does not is a hole in
 * whichever rule carries the narrower copy, and one invisible from inside
 * either rule, since each stays self-consistent with its own. That is why the
 * readers are resolved here rather than in each rule that needs one.
 */

/**
 * The api's Redis key-registry helpers — the whole set
 * `apps/api/src/lib/redis/operations.ts` publishes.
 *
 * Whole, because a rule that re-types the subset it happens to care about
 * publishes a narrower list as if it were the registry, and the next helper
 * added lands in one rule's vocabulary and not the other's. That already
 * happened: `redisDel`, `redisTtl` and `redisMGetEntry` were known to
 * `rate-limit-keys-use-the-primitive` and invisible to `no-lossy-counter-gate`,
 * which scans the same files. A rule wanting a subset now selects it out of this
 * list, and {@link RedisRegistryOperation} makes that selection total.
 */
export const REDIS_REGISTRY_OPERATIONS = [
  'redisDel',
  'redisGet',
  'redisGetDel',
  'redisMGet',
  'redisMGetEntry',
  'redisSet',
  'redisSetNx',
  'redisTtl',
] as const;

export type RedisRegistryOperation = (typeof REDIS_REGISTRY_OPERATIONS)[number];

/**
 * A Lua dispatch of a Redis command, in the spellings this matches:
 * `redis.call` and the error-tolerant `redis.pcall`, reached by field or by
 * index, under either the `redis` name or its `server` alias, with or without
 * space around the member access and before the argument list. Captures the
 * command; reading the argument list needs a counter rather than a pattern, so
 * each rule scans it for itself.
 *
 * Spellings the server accepts and this does not match include a command in a
 * long-bracket string (`redis.call([[INCR]], KEYS[1])`) and Lua's call sugar
 * (`redis.call'INCR'`), which is why each rule's residual list is marked
 * representative rather than exhaustive.
 *
 * A match ends at its command name and consumes none of its arguments, so a
 * dispatch nested in another's argument list — `redis.call('SET', KEYS[2],
 * redis.call('INCR', KEYS[1]))` — is matched in its own right. The counting
 * call is the inner one.
 */
export const LUA_CALL =
  /(?:redis|server)\s*(?:\.\s*|\[\s*['"])p?call(?:['"]\s*\])?\s*\(\s*(?<quote>['"])(?<command>\w+)\k<quote>/gi;

/** A dispatch decoded: the command it names, and where its argument list starts. */
interface LuaDispatch {
  /** Lower-cased, because Redis command names are case-insensitive. */
  readonly command: string;
  /** The offset in the script text just past the command name. */
  readonly argumentsAt: number;
}

/**
 * Every dispatch {@link LUA_CALL} matches in a script's text, decoded. The
 * capture-group name and the arithmetic that turns a match into an offset are
 * contract with
 * {@link LUA_CALL} rather than with any rule: a reader that spelled the group
 * differently would read every command as `''` and go silently blind, so the
 * decode is done once and each rule scans arguments from `argumentsAt` its own
 * way.
 */
export function luaDispatches(text: string): LuaDispatch[] {
  return [...text.matchAll(LUA_CALL)].map((match) => ({
    /* v8 ignore next -- @preserve unreachable `?? ''`: LUA_CALL's `command` group is not
       optional, so every match carries it; the fallback answers the index signature. */
    command: (match.groups?.['command'] ?? '').toLowerCase(),
    argumentsAt: match.index + match[0].length,
  }));
}

/**
 * An interpolation hole, standing in for a value that is not in the source text.
 *
 * Its VALUE decides verdicts, so it is neither empty nor numeric. Empty would
 * close a command name up across the hole — `INC${x}BY` would read as the
 * `INCRBY` nobody wrote — and a numeric stand-in would read as an amount of
 * one, so an interpolated amount would count as an event step.
 */
const HOLE = 'HOLE';

/**
 * A template's script text as one string, each hole stood in for. Judging the
 * chunks separately would lose every construct that straddles a hole, and where
 * the hole falls is the author's formatting, not part of the script.
 */
export function templateText(template: TemplateExpression): string {
  const spans = template
    .getTemplateSpans()
    .map((span) => HOLE + span.getLiteral().getLiteralText());
  return template.getHead().getLiteralText() + spans.join('');
}

/**
 * The method a call names and the receiver it names it on, reached by field or
 * by string index — `redis['incr']` is `redis.incr`. This is the client-side
 * twin of `LUA_CALL`: both read which command a dispatch names, on the two
 * sides the rules scan.
 *
 * The receiver rides along because it is free in both branches — every callee
 * this reads has one — and a caller that tests the receiver would otherwise
 * have to re-read the callee to reach it. A caller wanting only the name takes
 * `?.name`.
 */
export function calledMember(call: CallExpression): { name: string; receiver: Node } | undefined {
  const callee = call.getExpression();
  if (Node.isPropertyAccessExpression(callee)) {
    return { name: callee.getName(), receiver: callee.getExpression() };
  }
  if (!Node.isElementAccessExpression(callee)) return undefined;
  const index = callee.getArgumentExpression();
  if (index === undefined || !Node.isStringLiteral(index)) return undefined;
  return { name: index.getLiteralText(), receiver: callee.getExpression() };
}

/** A Redis client's name, in the spellings a receiver carries one under. */
const REDIS_CLIENT = /redis/i;

/**
 * A receiver naming a Redis client anywhere in its written text.
 *
 * The wider of the two receiver readings here, and the one a caller wants when
 * it REFUSES the call rather than decoding it: a receiver assembled out of a
 * client — `withClient(deps.redis).set(...)` — dispatches to Redis just as
 * plainly as `deps.redis.set(...)`, and reading only the name it ends in would
 * let it through.
 */
export function receiverTextNamesRedis(receiver: Node): boolean {
  return REDIS_CLIENT.test(receiver.getText());
}

/**
 * The one name a receiver ENDS in: `redis` for `deps.redis`, and the receiver
 * of the callee for a chained call (`deps.redis.createScript(script).exec(...)`).
 */
function receiverTailName(receiver: Node): string | undefined {
  if (Node.isIdentifier(receiver)) return receiver.getText();
  if (Node.isPropertyAccessExpression(receiver)) return receiver.getName();
  if (!Node.isCallExpression(receiver)) return undefined;
  const inner = calledMember(receiver);
  return inner === undefined ? undefined : receiverTailName(inner.receiver);
}

/**
 * A receiver whose ending name is a Redis client's.
 *
 * The narrower reading, and NOT a lapsed copy of
 * {@link receiverTextNamesRedis} — the two answer different questions and both
 * are wanted, so a spelling this one refuses is not a hole in it. A chained
 * builder's receiver is every call before it, so under the wider reading a
 * route chain that mentions a Redis dependency anywhere reads as a Redis call
 * at each link. A caller that goes on to DECODE the call — reading its
 * arguments and judging them — takes this one, because a false positive there
 * reports a violation on an argument that was never a Redis key.
 */
export function receiverTailNamesRedis(receiver: Node): boolean {
  const name = receiverTailName(receiver);
  return name !== undefined && REDIS_CLIENT.test(name);
}

/**
 * The literals a script can be written as, with the node a rule reports the
 * line from: plain strings, templates with no substitutions, and interpolated
 * templates read as one script each. A script assembled at runtime out of
 * values is not a literal and is not here; each rule's residual list bounds
 * that.
 *
 * A literal is judged on its own text, so a script a package exports for the
 * worker to run is found where the string is written rather than where it runs.
 */
export function scriptLiterals(sourceFile: SourceFile): { node: Node; text: string }[] {
  const plain = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ].map((literal) => ({ node: literal as Node, text: literal.getLiteralText() }));
  const templates = sourceFile
    .getDescendantsOfKind(SyntaxKind.TemplateExpression)
    .map((template) => ({ node: template as Node, text: templateText(template) }));
  return [...plain, ...templates];
}
