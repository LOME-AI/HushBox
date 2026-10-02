import { match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import type { ErrorCode } from '@hushbox/shared';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * The closed set of terminal run failures, bookkeeping for telemetry and the
 * typed wire code. One failure can carry a committed effect: a settlement
 * refusal reaches the engine after the definition's refusal commit billed the
 * run's charges, or found nobody to bill, and flipped the key row, with nothing
 * saved. Every other failure leaves zero committed effects.
 */
export type RunFailure =
  // `code` carries a specific validation refusal (e.g. an unsupported video
  // resolution surfaced while pricing) through the pre-admission path; absent,
  // it stays the generic VALIDATION.
  | { readonly kind: 'inputs-invalid'; readonly code?: ErrorCode }
  | { readonly kind: 'byte-budget-exceeded' }
  | { readonly kind: 'admission-refused'; readonly code: ErrorCode }
  // `code` carries a specific provider-failure reason (content policy, context
  // length, network) to the client; absent, it stays the generic UNAVAILABLE.
  | { readonly kind: 'node-failed'; readonly nodeId: string; readonly code?: ErrorCode }
  // Every branch of a multi-model turn failed, so settlement had no persistable
  // content to commit — a real "the providers were unavailable" outcome, not an
  // engine defect: the run is rerouted to UNAVAILABLE and never captured to
  // Sentry. The signal is read off content rather than off charge count, because
  // a run may charge for a generation that persists nothing of its own.
  | { readonly kind: 'all-branches-failed' }
  // A dependency the run needed did not answer. Not an engine defect, so the
  // run fails UNAVAILABLE rather than INTERNAL, and it is captured anyway —
  // an outage no one is paged for is an outage no one fixes.
  | { readonly kind: 'infrastructure-unavailable' }
  // An expected settlement refusal, signalled by the settlement hook throwing
  // the typed SettlementConflictError sentinel. Not an engine defect: `code`
  // carries the specific client wire code and the run is never captured to
  // Sentry.
  | { readonly kind: 'settlement-conflict'; readonly code: ErrorCode }
  | { readonly kind: 'defect' };

/**
 * The typed sentinel a settlement hook throws when the run produced zero
 * billable content — every branch of a multi-model turn failed. It lives here,
 * beside the `'all-branches-failed'` failure kind, so the producer (chat's
 * settlement hook, which imports it via the workflows barrel) and the engine's
 * `settle()` catch are compile-linked: a rename breaks typecheck, never
 * silently misroutes the all-models-failed turn to INTERNAL + Sentry. The
 * engine discriminates it with `instanceof` (an intra-slice import — the engine
 * must not depend on the chat slice), reroutes to `'all-branches-failed'` →
 * UNAVAILABLE, and never captures it. It is a runtime class, not an
 * `import type`.
 */
export class AllBranchesFailedError extends Error {
  constructor(message = 'settlement: every branch failed, no billable content produced') {
    super(message);
    this.name = 'AllBranchesFailedError';
  }
}

/**
 * The typed error a chat run throws when a dependency it needed did not produce
 * a usable answer: an adapter's Result channel carrying an availability code
 * (`isAvailabilityCode`), as against a refusal it computed. Like
 * `AllBranchesFailedError` it lives beside its failure kind so its producers
 * (chat's, reaching it through the workflows barrel) and the engine's catch
 * sites are compile-linked. The engine discriminates it via `instanceof` and
 * reroutes to `'infrastructure-unavailable'` → UNAVAILABLE, so the user is
 * never shown INTERNAL over someone else's outage.
 *
 * It is captured under its own fingerprint: the wire code tells the user the
 * system is down, and nothing in it tells an operator which dependency failed.
 * Whether a neighbouring sentinel captures is stated in its own docblock.
 */
export class InfrastructureUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InfrastructureUnavailableError';
  }
}

/**
 * The typed sentinel the chat settlement hook throws for an expected settlement
 * refusal: any state the settling transaction re-checks and rejects. Like the
 * sentinels above it lives beside its failure kind so the producer (chat's
 * settlement hook, importing it via the workflows barrel) and the engine's
 * `settle()` catch are compile-linked. The engine discriminates it via
 * `instanceof`, reroutes to `'settlement-conflict'`, and NEVER captures it
 * (observability doctrine: expected domain failures are `Result` `{code}`
 * values, never Sentry).
 *
 * It carries the underlying `DomainError`, whose `wireCode` override names the
 * chat-specific client code the engine projects through `domainWireCode`; a
 * refusal added later brings its own code and needs no new branch. A plain
 * `Error` is reserved for a genuine defect, which is why the unreachable
 * fork-tip CAS zero-row throws one (`advanceForkTip`) and still routes to
 * `'defect'` + Sentry.
 */
export class SettlementConflictError extends Error {
  constructor(
    readonly domainError: DomainError,
    message: string
  ) {
    super(message);
    this.name = 'SettlementConflictError';
  }
}

/**
 * A settlement refusal nobody could be billed for. It carries the refusal's own
 * domain error, so the caller gets the refusal's code; the engine additionally
 * reports the run's provider spend as absorbed platform loss. It lives beside
 * its parent so the settlement plumbing that mints it and the engine's catch are
 * compile-linked without the engine importing the settlement plumbing.
 */
export class AbsorbedSettlementRefusal extends SettlementConflictError {
  constructor(refusal: SettlementConflictError) {
    super(refusal.domainError, refusal.message);
    this.name = 'AbsorbedSettlementRefusal';
  }
}

/** One absorbed platform loss: what absorbed it, for which run, and how much. */
interface AbsorbedLoss {
  readonly name: string;
  readonly summary: string;
  readonly runId: string | undefined;
  readonly absorbedNanoUsd: bigint;
}

/**
 * The one builder of every absorbed-loss event the engine raises: provider spend
 * the platform pays and does not bill. The Sentry scrub keys on the two own
 * properties it sets and drops the message, so `runId` and `absorbedNanoUsd` are
 * the only path the run and the loss survive to the wire. `runId` is the
 * DO-minted random run id, never the client-supplied `runKey`, which would bypass
 * the scrub; the amount is the nano-USD bigint as a string, never
 * Number()-coerced.
 */
export function absorbedLossEvent(loss: AbsorbedLoss): Error {
  const absorbed = loss.absorbedNanoUsd.toString();
  const error = new Error(
    `${loss.summary}: run ${String(loss.runId)} absorbed ${absorbed} nano-USD unbilled`
  );
  error.name = loss.name;
  return Object.assign(error, { runId: loss.runId, absorbedNanoUsd: absorbed });
}

/** The cost circuit's closing of one run's spend gate. */
interface CostCircuitTrip {
  readonly runId: string | undefined;
  readonly accruedNanoUsd: bigint;
  readonly limitNanoUsd: bigint;
}

/**
 * The event the cost circuit raises when it is the first to close a run's spend
 * gate: which run, the spend it had accrued, and the `hold × K` limit that
 * spend crossed. `runId` is the DO-minted random run id, never the
 * client-supplied `runKey`; the amounts are nano-USD bigints as strings, never
 * Number()-coerced.
 */
export function costCircuitTripEvent(trip: CostCircuitTrip): Error {
  const accrued = trip.accruedNanoUsd.toString();
  const limit = trip.limitNanoUsd.toString();
  const error = new Error(
    `cost circuit closed the spend gate: run ${String(trip.runId)} accrued ${accrued} nano-USD over a ${limit} nano-USD limit`
  );
  error.name = 'CostCircuitTripped';
  return Object.assign(error, { runId: trip.runId, accruedNanoUsd: accrued, limitNanoUsd: limit });
}

/**
 * Wire-code projection for FlowRunOutcome. Byte-budget breaches reuse VALIDATION
 * — the closed error-code set has no dedicated code for that yet; the mapping is
 * deliberate, not accidental.
 */
export function runFailureCode(failure: RunFailure): ErrorCode {
  return match(failure)
    .with({ kind: 'inputs-invalid' }, (invalid) => invalid.code ?? ERROR_CODES.VALIDATION)
    .with({ kind: 'byte-budget-exceeded' }, () => ERROR_CODES.VALIDATION)
    .with({ kind: 'admission-refused' }, (refused) => refused.code)
    .with({ kind: 'node-failed' }, (failed) => failed.code ?? ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'all-branches-failed' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'infrastructure-unavailable' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'settlement-conflict' }, (conflict) => conflict.code)
    .with({ kind: 'defect' }, () => ERROR_CODES.INTERNAL)
    .exhaustive();
}
