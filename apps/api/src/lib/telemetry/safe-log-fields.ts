/**
 * The closed allowlist of structured-log field names.
 * Redaction-by-default: user content is unrepresentable because no field name
 * here can carry it — there is deliberately no message/prompt/content/body/
 * text field, and additions must survive the never-log list (message content,
 * prompts, outputs, keys, ciphertext, PII, request/response bodies).
 *
 * The compile-time layer (this type + `ExactSafeLogFields`) rejects unknown
 * keys; `pickSafeLogFields` is the runtime scrub for callers that arrive
 * through casts or plain JS. Both layers are required: the redaction regex
 * lint is advisory only — the typed logger plus port-side scrubbing are the
 * real mechanisms.
 */

import type { Dependency, DependencyFailureArm } from '../context/dependency-failure.js';
import type { RateLimitFailure } from '../rate-limit/index.js';

export const SAFE_LOG_FIELD_KEYS = [
  'requestId',
  'userId',
  'conversationId',
  'runId',
  'jobId',
  'route',
  'method',
  'statusCode',
  'latencyMs',
  'modelName',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'errorCode',
  'jobType',
  'attempt',
  'droppedCount',
  'generationId',
  'successCount',
  'failureCount',
  'rateLimitFailure',
  'ageMinutes',
  'dependency',
  'dependencyFailure',
  'dependencyLate',
] as const;

export type SafeLogFieldKey = (typeof SAFE_LOG_FIELD_KEYS)[number];

export interface SafeLogFields {
  readonly requestId?: string;
  readonly userId?: string;
  readonly conversationId?: string;
  // The run id its minter assigned (the room's own `newRunId()`, threaded to
  // the interpreter as `FlowStartRequest.runId`). A content-free correlation
  // id, which the client-supplied Idempotency-Key naming the same run is not:
  // that key is caller input and belongs to no field here.
  readonly runId?: string;
  readonly jobId?: string;
  // The provider's opaque generation identifier (OpenRouter's generation id,
  // already stored plaintext in usage_records). A content-free correlation id
  // like runId/jobId. Outside usage_records it appears only on the
  // billable-generation log line, which no watcher reads, so a killed run's
  // provider spend is not reconcilable from it.
  readonly generationId?: string;
  // The matched route TEMPLATE (`/conversations/:id`), never the concrete
  // URL — query strings and path tokens would leak content.
  readonly route?: string;
  readonly method?: string;
  readonly statusCode?: number;
  readonly latencyMs?: number;
  readonly modelName?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  // Observability dimension only (a float), never settlement math — ledger
  // money stays nano-USD bigint per the money doctrine.
  readonly costUsd?: number;
  readonly errorCode?: string;
  readonly jobType?: string;
  readonly attempt?: number;
  /** Count of items a salvaging/validation pass discarded (e.g. invalid banner messages). */
  readonly droppedCount?: number;
  // The two halves of a best-effort fan-out's outcome (push delivery today):
  // how many targets the transport accepted and how many it rejected. Counts
  // only — a target is a device token or a subscription endpoint and neither
  // is representable here, so the pair says how badly a send went and never to
  // whom.
  readonly successCount?: number;
  readonly failureCount?: number;
  // Which failure left a rate-limit counter unspendable, typed as the counting
  // primitive's own closed union rather than `string`: the four literals are
  // the whole value space this name can carry, so no caller can widen it. The
  // bound is the point — the error behind such a failure holds the client's
  // serialized Redis command, whose KEYS embed the identity being counted, so
  // a `string` here would be a standing invitation to log it.
  readonly rateLimitFailure?: RateLimitFailure;
  // How old the thing an auditor found is, in whole minutes. A duration
  // measured by the auditor against its own clock, so it names no instant and
  // discloses nothing about what the aged thing holds.
  readonly ageMinutes?: number;
  // Which dependency an availability refusal met, on which arm, and whether the
  // isolate's own event loop was late, typed as the classifier's closed unions
  // rather than `string`: the classification is read from errors whose messages
  // embed query text and counter keys, and the unions are the whole value space
  // these names can carry, so no caller can widen them to that text.
  readonly dependency?: Dependency;
  readonly dependencyFailure?: DependencyFailureArm;
  readonly dependencyLate?: boolean;
}

/**
 * Exact-object constraint for logger `fields` parameters: any key of F that
 * is not an allowlisted field types as `never`, so excess keys fail to
 * compile even when the argument is a pre-built variable (where TS's literal
 * excess-property check would not fire).
 */
export type ExactSafeLogFields<F extends SafeLogFields> = F &
  Readonly<Record<Exclude<keyof F, keyof SafeLogFields>, never>>;

/**
 * Runtime allowlist scrub applied at emission: keeps only allowlisted keys
 * whose values are primitives (string/number/boolean). Objects, arrays, and
 * anything smuggled past the types via a cast are dropped — a string can still
 * carry content, but that is the compile-time and lint layers' job; the runtime
 * layer guarantees shape, not semantics.
 */
export function pickSafeLogFields(
  fields: SafeLogFields
): Partial<Record<SafeLogFieldKey, string | number | boolean>> {
  const picked: Partial<Record<SafeLogFieldKey, string | number | boolean>> = {};
  for (const key of SAFE_LOG_FIELD_KEYS) {
    // Typed as a primitive or undefined, but runtime callers arriving through
    // casts can put anything here — hence the typeof check below.
    const value: unknown = fields[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      picked[key] = value;
    }
  }
  return picked;
}
