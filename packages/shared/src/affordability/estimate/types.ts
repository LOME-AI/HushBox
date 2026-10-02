/**
 * The canonical estimator's shared vocabulary: nano-USD line items, the cost
 * manifest, the media rate key a call is charged by, and the fail-closed result
 * channel.
 *
 * The manifest is the extension point. A new cost source (media, a tool loop, a
 * Smart-Model classifier stage) is ADDED as one or more {@link NanoLineItem}s —
 * the reducers ({@link Manifest} → ceiling / affordability) never change shape.
 * That is why costs are modelled as line items rather than named fields.
 */

/**
 * One nano-USD cost component, at BILLABLE (fee-inclusive) rates — fees are
 * baked at the catalog-ingestion seam, never applied here. A line item is
 * either fixed (known before generation) or scales with the output-token
 * count, or both; each is summed into its respective subtotal by the reducers.
 * `kind` discriminates provider cost (model/media inference, tool calls,
 * classifier — billable rates) from pass-through storage (never fee-bearing;
 * dropped on non-persisting turns).
 */
export interface NanoLineItem {
  /** Human-readable category, for debugging and breakdown display. */
  readonly label: string;
  /** Cost incurred regardless of output length, in nano-USD. */
  readonly fixedNano?: bigint;
  /** Cost per output token, in nano-USD. */
  readonly variableOutputRateNano?: bigint;
  /** Provider (billable inference/tool calls/classifier) vs pass-through storage. */
  readonly kind: 'provider' | 'storage';
}

/** A request's full cost structure as billable nano-USD line items. */
export interface Manifest {
  readonly items: readonly NanoLineItem[];
}

/**
 * The per-unit rate a media call is charged by: per image, or per second at a
 * resolution, which the call names as its dimension key.
 */
export type MediaRateKey = 'perImage' | 'perSecondByResolution';

export type EstimateErrorCode = 'model-pricing-incomplete' | 'invalid-request';

/** A fail-closed pricing failure: a data/input condition, not a thrown defect. */
export interface EstimateError {
  readonly code: EstimateErrorCode;
  readonly detail: string;
}

/**
 * The estimator's typed error channel. Shared has no neverthrow dependency, so
 * pricing returns this discriminated union (the seam the plan writes as
 * `Result<Manifest, DomainError>`); the server maps it to its own `Result` at
 * the boundary.
 */
export type EstimateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EstimateError };

export function estimateOk<T>(value: T): EstimateResult<T> {
  return { ok: true, value };
}

export function estimateErr<T>(code: EstimateErrorCode, detail: string): EstimateResult<T> {
  return { ok: false, error: { code, detail } };
}
