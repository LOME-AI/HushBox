import { Node, SyntaxKind } from 'ts-morph';
import { isFetchCall } from '../lib/external-calls.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import {
  REDIS_REGISTRY_OPERATIONS,
  calledMember,
  receiverTextNamesRedis,
} from '../lib/redis-calls.js';
import type { CallExpression } from 'ts-morph';
import type { ExternalPort } from '../lib/external-calls.js';
import type { RedisRegistryOperation } from '../lib/redis-calls.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The doctrine: operation patterns A and D admit no external call inside a DB
 * transaction, and the settlement transaction contains no external or Redis
 * call, ever.
 *
 * A `db.transaction(...)` callback commits domain state; a call out of it would
 * make the transaction's duration a network round-trip and defeat
 * crash-recovery-by-construction (a killed run between the external effect and
 * the commit is exactly what pattern D exists to avoid). Pattern D keeps the
 * external effect OUTSIDE the transaction by construction —
 * `byExternalPreClaim` runs pre-claim → external → finalize as three separate
 * steps — so a correct card-charge never puts the external call in a tx and is
 * never flagged. Redis is refused on the same ground plus one of its own: a
 * hold or snapshot written inside the tx is not covered by the tx, so a
 * rollback leaves it standing.
 *
 * Three shapes are refused lexically inside a `.transaction(callback)`, in a
 * non-test source file:
 *
 * 1. `fetch` — whatever `lib/external-calls.ts` defines one to be, which
 *    admin-op-purity refuses from that same definition rather than a second
 *    copy of it.
 * 2. A Redis call — a round-tripping helper from the key registry, or a command
 *    on a redis-named receiver ({@link REDIS_ROUND_TRIP_HELPERS},
 *    {@link receiverTextNamesRedis}).
 * 3. A call on the injected external-port surface, by receiver name
 *    ({@link EXTERNAL_PORT_RECEIVERS}).
 *
 * Syntactic only, and each shape carries the same limit: a port reached under a
 * name the set does not carry, a Redis client bound to a name with no `redis`
 * in it, or a `fetch` off a captured binding all read as ordinary domain calls.
 * The residual runs the other way too — a key-building call on a redis-named
 * receiver reads as a dispatch, which is why the registry's own non-round-trip
 * helper is classified rather than assumed.
 *
 * Scope is every scanned tree, not the api app. Crash-recovery-by-construction
 * is a property of the transaction, not of the package the transaction happens
 * to sit in — `packages/db` opens real ones — and the remedy (move the external
 * effect outside the tx) is available wherever the transaction is written.
 */

/**
 * Whether a registry helper reaches the server. Total over the registry so a
 * helper added there must be classified here rather than defaulting into
 * either answer — `redisMGetEntry` builds a key and makes no round trip, so
 * refusing it would refuse a pure computation.
 */
const HELPER_REACHES_REDIS: Readonly<Record<RedisRegistryOperation, boolean>> = {
  redisDel: true,
  redisGet: true,
  redisGetDel: true,
  redisMGet: true,
  redisMGetEntry: false,
  redisSet: true,
  redisSetNx: true,
  redisTtl: true,
};

const REDIS_ROUND_TRIP_HELPERS = new Set<string>(
  REDIS_REGISTRY_OPERATIONS.filter((operation) => HELPER_REACHES_REDIS[operation])
);

/**
 * The receiver names an external-infra port is injected under, each mapped to
 * the port it names. Name-based because the port's own `fetch` lives in its
 * adapter module, never at the call site — `deps.storage.put(...)` is a network
 * round-trip whose only local evidence is the name `storage`.
 *
 * Every entry is a name a port interface is bound to in production code today.
 * The completeness posture is accepted rather than solved: a new external port,
 * or a new spelling of an existing one, is unrefused until it is added here —
 * one line, in this object. The alternative, resolving each receiver's type,
 * costs whole-program type resolution the layer deliberately does not pay for,
 * and a broader name heuristic would refuse ordinary domain calls, which is the
 * failure that matters most here: this rule stands over the settlement
 * transaction, where money and content commit together. The residual runs the
 * other way too: every name here is also an ordinary domain word, bound to
 * non-port values elsewhere in the scanned trees, so a hit is read before it is
 * obeyed — a receiver that is genuinely not a port is a false positive, not a
 * finding.
 */
const EXTERNAL_PORT_RECEIVERS: Readonly<
  Record<string, ExternalPort | `${ExternalPort} or ${ExternalPort}`>
> = {
  compute: 'TransformCompute',
  fcm: 'PushSender',
  logger: 'Telemetry',
  provider: 'ModelProvider or PaymentProvider',
  push: 'PushSender',
  realtime: 'RealtimeBroadcast',
  sender: 'EmailSender or PushSender',
  storage: 'Storage',
  telemetry: 'Telemetry',
  webPush: 'PushSender',
};

function isTransactionCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getName() === 'transaction';
}

const EXTERNAL_IN_TX_MESSAGE =
  'external call (fetch) inside a db.transaction() callback — a plain transaction admits no external calls; keep the external effect outside the tx (pattern D: byExternalPreClaim).';

const REDIS_IN_TX_MESSAGE =
  'Redis call inside a db.transaction() callback — the transaction admits no Redis call, and a hold or snapshot written inside it survives the rollback that discards the rest; keep the Redis effect outside the tx.';

function portInTransactionMessage(port: string): string {
  return `call on the ${port} port inside a db.transaction() callback — a port call is a network round-trip, and the transaction admits none; keep the external effect outside the tx (pattern D: byExternalPreClaim).`;
}

/** `deps.storage` → `storage`; the name a member chain's receiver ends in. */
function receiverName(receiver: Node): string | undefined {
  if (Node.isIdentifier(receiver)) return receiver.getText();
  if (Node.isPropertyAccessExpression(receiver)) return receiver.getName();
  return undefined;
}

/** Why this call may not stand in a transaction, or nothing when it may. */
function refusal(call: CallExpression): string | undefined {
  if (isFetchCall(call)) return EXTERNAL_IN_TX_MESSAGE;
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) {
    return REDIS_ROUND_TRIP_HELPERS.has(callee.getText()) ? REDIS_IN_TX_MESSAGE : undefined;
  }
  const member = calledMember(call);
  if (member === undefined) return undefined;
  if (receiverTextNamesRedis(member.receiver)) return REDIS_IN_TX_MESSAGE;
  const port = EXTERNAL_PORT_RECEIVERS[receiverName(member.receiver) ?? ''];
  return port === undefined ? undefined : portInTransactionMessage(port);
}

/** Every refused call lexically inside this call's transaction callback (empty
 * when the call is not a `.transaction(callback)`). */
function refusedCallsInTransaction(call: CallExpression, filePath: string): ArchViolation[] {
  if (!isTransactionCall(call)) return [];
  const callback = call.getArguments()[0];
  if (callback === undefined) return [];
  return callback.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((inner) => {
    const message = refusal(inner);
    return message === undefined
      ? []
      : [{ file: filePath, line: inner.getStartLineNumber(), message }];
  });
}

const rule: ArchRule = {
  name: 'no-external-call-in-transaction',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (isTestFile(filePath)) continue;
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        violations.push(...refusedCallsInTransaction(call, filePath));
      }
    }
    return violations;
  },
};

export default rule;
