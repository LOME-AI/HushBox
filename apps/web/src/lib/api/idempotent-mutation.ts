/**
 * Per-mutation `Idempotency-Key` that survives TanStack retries.
 *
 * The app configures `mutations.retry` (see `providers/query-provider.tsx`), and
 * TanStack re-invokes `mutationFn(variables)` on every retry with the SAME
 * `variables` object reference. Minting a uuid inside `mutationFn` would produce
 * a fresh key per attempt — defeating server-side dedup in exactly the retry
 * case the key exists for. Keying a `WeakMap` on the stable `variables`
 * reference mints once per logical `mutate()` call and reuses it across retries;
 * the entry is collected with the `variables` object, so nothing leaks. The chat
 * run path (`hooks/chat/use-chat-stream.ts`) mints its key here too, inside the
 * mutation it builds on the query client's cache, from one `variables` object per
 * turn, so the turn's resubmits share the key as well as its retries.
 */
const keyByVariables = new WeakMap<object, string>();

/**
 * The idempotency key for one logical mutation. Stable across TanStack retries
 * of the same `mutate()` call (same `variables` reference), fresh for a new call.
 */
export function idempotencyKeyFor(variables: object): string {
  const existing = keyByVariables.get(variables);
  if (existing !== undefined) return existing;
  const key = crypto.randomUUID();
  keyByVariables.set(variables, key);
  return key;
}

/** The header the key rides on, spelled once for both the authoring and the reading side. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Per-call header object for a typed-client mutation, e.g.
 * `client.x.$post({ json }, idempotentHeaders(variables))`.
 */
export function idempotentHeaders(variables: object): {
  headers: { [IDEMPOTENCY_KEY_HEADER]: string };
} {
  dispatchCountByVariables.set(variables, dispatchCountFor(variables) + 1);
  return { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKeyFor(variables) } };
}

/**
 * How many requests one logical mutation has authored under its key.
 *
 * Counted where each outgoing request's headers are built — one call, one
 * request — so it counts requests rather than failures. That is what makes it
 * stable under the retry policy: a change there alters how many requests get
 * made, and every one of them is counted, but it cannot alter what the number
 * means. `failureCount` cannot stand in for it, because the same server
 * response reads 1 under a policy that declines to retry it and 3 under one
 * that does.
 *
 * A headers object built for a request that is then not sent still counts. The
 * overstatement is deliberate: a caller asking what reached the server is
 * pushed toward "unknown", never toward a safety it has not earned.
 */
const dispatchCountByVariables = new WeakMap<object, number>();

export function dispatchCountFor(variables: object): number {
  return dispatchCountByVariables.get(variables) ?? 0;
}

/**
 * What each of those requests came back with, in dispatch order.
 *
 * Recorded by the mutation's own transport seam, the only place every attempt
 * is visible: TanStack surfaces the last failure alone, and a caller reading
 * only that one cannot tell whether an earlier attempt reached the server —
 * which is the difference between a write that provably never happened and one
 * whose outcome is unknown.
 */
const dispatchFailuresByVariables = new WeakMap<object, unknown[]>();

export function recordDispatchFailure(variables: object, failure: unknown): void {
  const recorded = dispatchFailuresByVariables.get(variables);
  if (recorded === undefined) {
    dispatchFailuresByVariables.set(variables, [failure]);
    return;
  }
  recorded.push(failure);
}

export function dispatchFailuresFor(variables: object): readonly unknown[] {
  return dispatchFailuresByVariables.get(variables) ?? [];
}

/**
 * Which responses came back from a request that carried the key.
 *
 * A `Response` holds no reference to its request, and the throw site
 * (`fetchJson`) is handed only the response — so whether a key rode the
 * request is unknowable there without this. Keyed on the response object
 * itself so the fact travels with exactly the one failure it describes, and is
 * collected with it.
 */
const keyedResponses = new WeakSet<Response>();

/**
 * Records a response as having answered a keyed request, and returns it so the
 * fetch wrapper can record in its own return position. Only the seam that
 * authors the outgoing headers may call this: the fact is read off the wire,
 * never declared, which is what makes it safe to retry on.
 */
export function markRequestKeyed(response: Response, keyed: boolean): Response {
  if (keyed) keyedResponses.add(response);
  return response;
}

/**
 * Whether this response's request carried the key. False for a response no
 * fetch wrapper recorded, which keeps an unrecognized transport on the narrow
 * network-only mutation retry rather than widening it by omission.
 */
export function wasRequestKeyed(response: Response): boolean {
  return keyedResponses.has(response);
}

/**
 * The reasons a web mutation may send no `Idempotency-Key`, mirroring the
 * server's own vocabulary in `apps/api/src/lib/idempotency/middleware.ts` —
 * only the classes the browser's mutations actually fall into. Mirrored rather
 * than imported: that module is Worker code whose Hono middleware would follow
 * the strings into the SPA bundle.
 *
 * - `opaque-protocol` — an OPAQUE init/finish exchange. Redis challenge state
 *   is the dedup; a retry restarts the handshake harmlessly.
 * - `naturally-idempotent` — a conditional write landing the same end state on
 *   repeat (a preference PUT, a membership flag, a read cursor).
 * - `token-is-key` — the request carries a single-use token the server
 *   consumes atomically, so a repeat can never apply twice.
 *
 * Declaring one changes no retry behaviour: the retry follows the key on the
 * wire, so a mutation that sends none keeps the network-only arm whether or
 * not it says why. What the declaration buys is that the silence is
 * deliberate and named, which is what the architecture rule reads.
 */
export const MUTATION_IDEMPOTENCY_EXEMPTIONS = [
  'opaque-protocol',
  'naturally-idempotent',
  'token-is-key',
] as const;

type MutationIdempotencyExemption = (typeof MUTATION_IDEMPOTENCY_EXEMPTIONS)[number];

const EXEMPTION_SET: ReadonlySet<string> = new Set(MUTATION_IDEMPOTENCY_EXEMPTIONS);

/** The exemption a mutation declares, in TanStack's own `meta` slot. */
interface MutationIdempotencyMeta extends Record<string, unknown> {
  readonly idempotencyExemption: MutationIdempotencyExemption;
}

/**
 * Declares why a mutation sends no `Idempotency-Key`:
 * `useMutation({ meta: idempotencyExempt('naturally-idempotent'), … })`.
 *
 * The set is closed, so an unknown class arriving from a cast or an untyped
 * call site dies where it is declared rather than exempting silently — the
 * fail-fast the server's `idempotencyExempt` applies at route registration.
 */
export function idempotencyExempt(
  exemption: MutationIdempotencyExemption
): MutationIdempotencyMeta {
  if (!EXEMPTION_SET.has(exemption)) {
    throw new Error(`idempotency: unknown exemption class ${JSON.stringify(exemption)}`);
  }
  return { idempotencyExemption: exemption };
}
