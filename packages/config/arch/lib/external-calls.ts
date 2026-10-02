import { Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';

/**
 * What a `fetch` IS, for every rule that refuses one.
 *
 * It is `fetch` — bare, or off one of the three global aliases. That is the
 * whole reach, and it is narrower than "an external call": a provider, storage,
 * payment or email port does bottom out in `fetch`, but that `fetch` is written
 * in the port's adapter module, while a CALL on the port
 * (`deps.storage.put(...)`) carries no `fetch` at its own call site and is not
 * matched here. A rule that wants the injected-port surface refused names that
 * surface itself — `no-external-call-in-transaction` carries such a set, by
 * receiver name — and a rule that keeps adapters out by import instead, as
 * `admin-op-purity` does, reaches it that way.
 *
 * Resolved here because every rule that refuses `fetch` refuses it for its own
 * reason, and they all have to refuse the SAME thing. Teaching one copy a
 * global alias the others do not know would leave the rest silently narrower —
 * and their headers used to assert their agreement in prose, which is a promise
 * nothing enforced.
 *
 * A `fetch` reached any other way — off a captured binding, or by computed
 * index — is not read as one. That is the syntactic limit every reader here
 * accepts.
 */

const GLOBAL_ALIASES = new Set(['globalThis', 'self', 'window']);

/**
 * WHICH ports are the infra edges — the ones whose implementations reach off
 * the box.
 *
 * Resolved here for the same reason {@link isFetchCall} is: the rules ask
 * different questions of this set — `no-external-call-in-transaction` asks
 * which receiver NAME a port is injected under, and
 * `admin-external-ports-stay-post-commit` asks which TYPE a dependency is
 * declared as — but they are asking about one set, and a port added to the tree
 * is a port both must know. Two copies would let a new edge be taught to one
 * rule and be silently unrefused by the other, which is drift no test would
 * report. A consumer that keeps its own data (`EXTERNAL_PORT_RECEIVERS`, the
 * receiver-name map that is `no-external-call-in-transaction`'s own business)
 * is typed against this list, so an entry naming a port absent here does not
 * compile.
 *
 * This is the port set, not the reach: a port under a receiver name no rule
 * carries, or a dependency declared as an inline object type rather than the
 * port's own name, is unrefused. Each rule states its own residual.
 */
export const EXTERNAL_PORTS = [
  'EmailSender',
  'ModelProvider',
  'PaymentProvider',
  'PushSender',
  'RealtimeBroadcast',
  'Storage',
  'Telemetry',
  'TransformCompute',
] as const;

export type ExternalPort = (typeof EXTERNAL_PORTS)[number];

export function isFetchCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText() === 'fetch';
  if (!Node.isPropertyAccessExpression(callee)) return false;
  return callee.getName() === 'fetch' && GLOBAL_ALIASES.has(callee.getExpression().getText());
}
