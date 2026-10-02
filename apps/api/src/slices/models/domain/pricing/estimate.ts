import { ERROR_CODES } from '@hushbox/shared';
import {
  declaredCeilingError as sharedDeclaredCeilingError,
  estimateRunCeilingNanoUsd as sharedEstimateRunCeilingNanoUsd,
  mediaGenerationNanoUsd,
  reservedCallParts as sharedReservedCallParts,
} from '@hushbox/shared/affordability/estimate/run-ceiling';
import { priceAtBaseRates, priceSteps } from '@hushbox/shared/affordability/price/curve';
import { tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import { validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import type { CallShapeFamily, CallUsage, EstimateResult, Usage } from '@hushbox/shared';
import type {
  DeclaredCeiling,
  NodeStorage,
  ReservedCallParts,
} from '@hushbox/shared/affordability/estimate/run-ceiling';
import type { ModelPricing } from '@hushbox/shared/affordability/price/schedule';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * Estimate computation — the billable catalog rates are its ONLY price source,
 * so every amount here is billable with no fee math anywhere in this module.
 * Estimates feed admission holds and the settlement's `isEstimated` charge; the
 * authoritative charged cost lives in billing's settlement flow and is never
 * consulted here. Every cost formula lives ONCE in the shared price core inside
 * the money layer; this module is the thin server adapter that drives it and
 * translates the core's `EstimateResult` union into the domain `Result`
 * channel. A rate the usage needs but the pricing lacks is a validation error,
 * never a silent zero.
 */

// The token/media usage, declared-ceiling, and per-node storage shapes are the
// shared estimator core's — re-exported so the models slice's callers keep their
// `./estimate.js` import site.
export type { CallUsage } from '@hushbox/shared';
export type {
  DeclaredCeiling,
  NodeStorage,
  ReservedCallParts,
} from '@hushbox/shared/affordability/estimate/run-ceiling';

/** The core's typed pricing failure, surfaced through the domain `Result` channel. */
function fromEstimate<T>(result: EstimateResult<T>): Result<T, DomainError> {
  return result.ok ? ok(result.value) : err(validationError(result.error.detail));
}

/** The rate key an image call is charged by: one rate per output image. */
const IMAGE_RATE_KEY = 'perImage';

/** The rate key a video call is charged by: a per-second rate chosen by resolution. */
const VIDEO_RATE_KEY = 'perSecondByResolution';

/**
 * Deterministic media pricing inputs from a call's request parameters. Image
 * and video prices are computable up front (catalog rate × requested units),
 * so the SAME derivation feeds the admission ceiling and the settlement
 * charge. Fail-closed: a missing/invalid parameter or a non-media family is a
 * validation error — an unpriceable media call must refuse before any
 * provider spend, never fail after it.
 */
export function mediaCallUsageFor(
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<CallUsage, DomainError> {
  if (family === 'image') return imageCallUsage(params);
  if (family === 'video') return videoCallUsage(params);
  return err(validationError('Deterministic media pricing applies only to image/video calls'));
}

/**
 * One generation call produces exactly one artifact (founder ruling). A
 * multi-artifact request (`n > 1`) is refused fail-closed: admission would
 * under-reserve by n× and the node accumulator persists a single artifact, so
 * pricing n would bill artifacts the run never keeps.
 */
function requireSingleArtifact(params: Record<string, unknown>): Result<void, DomainError> {
  const n = params['n'] ?? 1;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    return err(validationError("Media call parameter 'n' must be a positive integer"));
  }
  if (n > 1) {
    return err(
      validationError("Media call parameter 'n' must be 1: one generation call, one artifact")
    );
  }
  return ok();
}

function imageCallUsage(params: Record<string, unknown>): Result<CallUsage, DomainError> {
  return requireSingleArtifact(params).map(() => ({
    kind: 'media' as const,
    rateKey: IMAGE_RATE_KEY,
    units: 1,
  }));
}

function videoCallUsage(params: Record<string, unknown>): Result<CallUsage, DomainError> {
  const singleArtifact = requireSingleArtifact(params);
  if (singleArtifact.isErr()) return err(singleArtifact.error);
  const resolution = params['resolution'];
  if (typeof resolution !== 'string' || resolution.length === 0) {
    return err(
      validationError(
        "Video call requires a 'resolution' parameter to price",
        undefined,
        ERROR_CODES.UNSUPPORTED_RESOLUTION
      )
    );
  }
  const durationSeconds = params['durationSeconds'];
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1
  ) {
    return err(
      validationError(
        "Video call requires a positive integer 'durationSeconds' to price",
        undefined,
        ERROR_CODES.UNSUPPORTED_DURATION
      )
    );
  }
  return ok({
    kind: 'media',
    rateKey: VIDEO_RATE_KEY,
    dimensionKey: resolution,
    units: durationSeconds,
  });
}

/**
 * A media call's BILLABLE deterministic price from the billable catalog rates
 * and request parameters, at the rate an estimated charge bills. Exact by
 * construction for image (charged as-is at settlement); for video it is the
 * pathological-missing-cost fallback and the inline-cost sanity bound. A
 * resolution absent from the price fails closed.
 */
export function priceMediaBillableNanoUsd(
  pricing: ModelPricing,
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<bigint, DomainError> {
  return mediaCallUsageFor(family, params).andThen((usage) =>
    usage.kind === 'media'
      ? fromEstimate(mediaGenerationNanoUsd(pricing, 'estimatedCharge', usage))
      : err(validationError('Deterministic media pricing applies only to image/video calls'))
  );
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * A call's observed token usage: every step's own, when each step reported one,
 * or else only the call's sum, whose split across steps is unknown.
 */
export type ObservedTokenUsage =
  | { readonly kind: 'perStep'; readonly steps: readonly Usage[] }
  | { readonly kind: 'summed'; readonly usage: Usage };

function countError(usage: Usage): DomainError | undefined {
  if (!isCount(usage.inputTokens)) {
    return validationError('Estimate inputTokens must be a non-negative integer');
  }
  if (!isCount(usage.outputTokens)) {
    return validationError('Estimate outputTokens must be a non-negative integer');
  }
  return undefined;
}

/**
 * One call's BILLABLE estimate from observed usage — the amount a model
 * binding's `price` returns. Each step is its own provider request, so each is
 * priced at the tier its own input reached. A sum with no known split is priced
 * at base rates: a sum can cross a threshold that no step crossed, and base
 * never exceeds the per-step price of any split. `reasoningTokens` is a SUBSET
 * of `outputTokens` — the provider reports completion tokens (text + reasoning)
 * as the output total and the reasoning count as a breakdown of it — so pricing
 * `outputTokens` at the output rate already bills reasoning; adding it again
 * would double-count. `cachedInputTokens` is likewise a subset of `inputTokens`
 * already counted at the full input rate (the catalog has no cache rate), so it
 * is left alone: a conservative over-estimate, never an under-charge.
 * Settlement charges the result directly on the estimate-fallback path; a `0n`
 * result is a legal no-charge (settlement is never balance-guarded).
 */
export function priceUsageBillableNanoUsd(
  pricing: ModelPricing,
  observed: ObservedTokenUsage
): Result<bigint, DomainError> {
  const tokens = tokenPricingOf(pricing);
  if (tokens === undefined) {
    return err(validationError('model pricing is not a token price'));
  }
  const usages = observed.kind === 'perStep' ? observed.steps : [observed.usage];
  for (const usage of usages) {
    const invalid = countError(usage);
    if (invalid !== undefined) return err(invalid);
  }
  return ok(
    observed.kind === 'perStep'
      ? priceSteps(tokens, 'estimatedCharge', observed.steps).nanoUsd
      : priceAtBaseRates(tokens, 'estimatedCharge', observed.usage)
  );
}

/**
 * One call's reserved parts across the run's declared worst case, via the shared
 * core, surfaced on the domain `Result` channel. With `storage` present the
 * node's output storage (token nodes) or media storage (media nodes) is
 * reserved, unmarked; absent, only provider cost is.
 */
export function reservedCallParts(
  pricing: ModelPricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): Result<ReservedCallParts, DomainError> {
  return fromEstimate(sharedReservedCallParts(pricing, usage, ceiling, storage));
}

/**
 * The admission estimate of one call: its reserved parts summed, surfaced on the
 * domain `Result` channel. A zero ceiling is rejected — it would place a zero
 * admission hold (free admission), which is always a caller bug, never a
 * legitimate run.
 */
export function estimateRunCeilingNanoUsd(
  pricing: ModelPricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): Result<bigint, DomainError> {
  return fromEstimate(sharedEstimateRunCeilingNanoUsd(pricing, usage, ceiling, storage));
}

/**
 * The shared core's declared-ceiling check on the domain `Result` channel, for
 * a caller that scales by a ceiling's multipliers without pricing a call
 * through it. Without this seam such a caller would carry its own copy of the
 * predicate, and the two would answer differently the first time either moved.
 */
export function declaredCeilingError(ceiling: DeclaredCeiling): DomainError | undefined {
  const invalid = sharedDeclaredCeilingError(ceiling);
  return invalid === undefined ? undefined : validationError(invalid.detail);
}
