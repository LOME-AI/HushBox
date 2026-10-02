/**
 * The admission run ceiling, one call at a time: a model's parsed price, the
 * call's usage and the declared width × iterations, priced through the price
 * core's cost curves, with failures surfaced on the shared
 * {@link EstimateResult} channel (shared has no neverthrow — the server re-maps
 * this to its own `Result` at the boundary).
 */

import { nanoUSD } from '../money/nano-usd.ts';
import { costAt, mediaCallCurve, textCallCurve, tiersAt } from '../price/curve.ts';
import { costPartsAt } from '../price/reservation.ts';
import { mediaPricingOf, tokenPricingOf } from '../price/wire.ts';
import { mediaStorageNanoUsd } from './storage-rate.ts';
import { estimateErr, estimateOk } from './types.ts';
import type { EstimateError, EstimateResult, MediaRateKey } from './types.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { CallQuantities } from '../price/curve.ts';
import type { MediaPricing, ModelPricing, PriceUse, TierIndex } from '../price/schedule.ts';
import type { ToolLoopBound } from '../tool-loop.ts';

/**
 * One priced call's usage: token counts with the tool loop the call may run, or
 * a media rate key with its units.
 */
export type CallUsage =
  | {
      readonly kind: 'tokens';
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Present exactly when the call carries a tool; priced step by step. */
      readonly toolLoop?: ToolLoopBound;
    }
  | {
      readonly kind: 'media';
      /** The unit the call is charged by: `perImage`, or `perSecondByResolution`; any other key is refused. */
      readonly rateKey: MediaRateKey;
      /** Required when the rate is a per-resolution matrix. */
      readonly dimensionKey?: string;
      readonly units: number;
    };

type MediaUsage = Extract<CallUsage, { kind: 'media' }>;

/**
 * The declared ceiling admission prices: max width × iterations. A tool loop's
 * steps are priced inside the call's curve, never multiplied here.
 */
export interface DeclaredCeiling {
  readonly maxFanOutWidth: number;
  readonly maxIterations: number;
}

/**
 * The per-node storage inputs a persisting turn adds to its ceiling. Absent ⇒
 * provider cost only (general workflows and every non-persisting call). Input
 * storage is NOT here — it is charged once per turn by the run estimator, not
 * per node. A token node's output storage needs no input: every output token
 * reserves its stored characters at the one stored-output ratio.
 */
export interface NodeStorage {
  /** Estimated encrypted output bytes (media nodes). */
  readonly mediaStorageBytes: number;
}

/** The output-token count a token usage emits; media has no token output leg. */
export function outputTokensOf(usage: CallUsage): bigint {
  return usage.kind === 'tokens' ? BigInt(usage.outputTokens) : 0n;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The one check on a declared ceiling's multipliers, for every caller that
 * scales anything by them — {@link reservedCallParts} here, and the server's
 * classifier reserve, which multiplies its own curve's cost by them.
 * Answers the first unusable dimension, or `undefined` when every one is usable.
 *
 * Unusable is not only "out of safe-integer range": an enclosure product deep
 * enough to overflow arrives as `Infinity`, and `BigInt(Infinity)` throws where
 * `BigInt(1e300)` does not. Both are refusals on the result channel, so no
 * caller of this has to know which one it is holding.
 */
export function declaredCeilingError(ceiling: DeclaredCeiling): EstimateError | undefined {
  const dimensions: readonly (readonly [string, number])[] = [
    ['maxFanOutWidth', ceiling.maxFanOutWidth],
    ['maxIterations', ceiling.maxIterations],
  ];
  for (const [label, value] of dimensions) {
    if (!Number.isSafeInteger(value) || value < 1) {
      return {
        code: 'invalid-request',
        detail: `Estimate ceiling ${label} must be a positive integer`,
      };
    }
  }
  return undefined;
}

type PerImagePricing = Extract<MediaPricing, { kind: 'perImage' }>;

type PerSecondPricing = Extract<MediaPricing, { kind: 'perSecond' }>;

function perImageNanoUsd(
  media: PerImagePricing,
  use: PriceUse,
  usage: MediaUsage
): EstimateResult<NanoUSD> {
  if (usage.dimensionKey !== undefined) {
    return estimateErr(
      'invalid-request',
      "media rate 'perImage' is flat; no dimension key applies"
    );
  }
  return estimateOk(costAt(mediaCallCurve(media, use, { images: usage.units }), 0));
}

function perSecondNanoUsd(
  media: PerSecondPricing,
  use: PriceUse,
  usage: MediaUsage
): EstimateResult<NanoUSD> {
  const resolution = usage.dimensionKey;
  if (resolution === undefined || !Object.hasOwn(media.anchor, resolution)) {
    return estimateErr(
      'model-pricing-incomplete',
      `model pricing 'perSecondByResolution' has no dimension '${String(resolution)}'`
    );
  }
  return estimateOk(costAt(mediaCallCurve(media, use, { seconds: usage.units, resolution }), 0));
}

/**
 * A media call's generation cost at `use`: the price's rate for the call's unit
 * times its units. Fail-closed on a price that is not per unit, a rate key the
 * price does not charge by, or a resolution it does not price.
 */
export function mediaGenerationNanoUsd(
  pricing: ModelPricing,
  use: PriceUse,
  usage: MediaUsage
): EstimateResult<NanoUSD> {
  const media = mediaPricingOf(pricing);
  if (!Number.isSafeInteger(usage.units) || usage.units < 1) {
    return estimateErr('invalid-request', 'media units must be a positive integer');
  }
  if (media?.kind === 'perImage' && usage.rateKey === 'perImage') {
    return perImageNanoUsd(media, use, usage);
  }
  if (media?.kind === 'perSecond' && usage.rateKey === 'perSecondByResolution') {
    return perSecondNanoUsd(media, use, usage);
  }
  return estimateErr('model-pricing-incomplete', `model pricing has no '${usage.rateKey}' rate`);
}

/**
 * One call as the ceiling reserves it. From {@link reservedCallParts} the money
 * parts include the declared width × iterations; the quantities, steps, cap and
 * tiers describe a single call.
 */
export interface ReservedCallParts {
  readonly quantities: CallQuantities;
  readonly steps: number;
  readonly wireCapTokens: number;
  readonly stepTiers: readonly TierIndex[];
  readonly providerNanoUsd: NanoUSD;
  readonly storageNanoUsd: NanoUSD;
}

function tokenCallParts(
  pricing: ModelPricing,
  usage: Extract<CallUsage, { kind: 'tokens' }>,
  persists: boolean
): EstimateResult<ReservedCallParts> {
  const tokens = tokenPricingOf(pricing);
  if (tokens === undefined) {
    return estimateErr('model-pricing-incomplete', 'model pricing is not a token price');
  }
  if (!isCount(usage.inputTokens)) {
    return estimateErr('invalid-request', 'Estimate inputTokens must be a non-negative integer');
  }
  if (!isCount(usage.outputTokens)) {
    return estimateErr('invalid-request', 'Estimate outputTokens must be a non-negative integer');
  }
  const quantities: CallQuantities = {
    promptTokens: usage.inputTokens,
    ...(usage.toolLoop === undefined ? {} : { loop: usage.toolLoop }),
    persists,
    newMessageChars: 0,
  };
  const curve = textCallCurve(tokens, 'reserve', quantities, usage.outputTokens);
  return estimateOk({
    quantities,
    steps: usage.toolLoop?.steps ?? 1,
    wireCapTokens: usage.outputTokens,
    stepTiers: tiersAt(curve, usage.outputTokens),
    ...costPartsAt(curve, usage.outputTokens),
  });
}

function mediaCallParts(
  pricing: ModelPricing,
  usage: MediaUsage,
  storage: NodeStorage | undefined
): EstimateResult<ReservedCallParts> {
  const generation = mediaGenerationNanoUsd(pricing, 'reserve', usage);
  if (!generation.ok) return generation;
  if (storage !== undefined && !isCount(storage.mediaStorageBytes)) {
    return estimateErr('invalid-request', 'media storageBytes must be a non-negative integer');
  }
  return estimateOk({
    quantities: { promptTokens: 0, persists: storage !== undefined, newMessageChars: 0 },
    steps: 1,
    wireCapTokens: 0,
    stepTiers: [],
    providerNanoUsd: generation.value,
    storageNanoUsd: nanoUSD(
      storage === undefined ? 0n : mediaStorageNanoUsd(storage.mediaStorageBytes)
    ),
  });
}

/**
 * One call's reserved parts across the run's declared worst case: its cost at
 * the usage's output ceiling, each step at the tier its own input bound resolves
 * to, multiplied by width × iterations. With `storage` present the call's
 * output storage (text) or media storage (media) is reserved; absent, only
 * provider cost is.
 */
export function reservedCallParts(
  pricing: ModelPricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): EstimateResult<ReservedCallParts> {
  const invalid = declaredCeilingError(ceiling);
  if (invalid !== undefined) return { ok: false, error: invalid };
  const parts =
    usage.kind === 'tokens'
      ? tokenCallParts(pricing, usage, storage !== undefined)
      : mediaCallParts(pricing, usage, storage);
  if (!parts.ok) return parts;
  const multiplier = BigInt(ceiling.maxFanOutWidth) * BigInt(ceiling.maxIterations);
  return estimateOk({
    ...parts.value,
    providerNanoUsd: nanoUSD(parts.value.providerNanoUsd * multiplier),
    storageNanoUsd: nanoUSD(parts.value.storageNanoUsd * multiplier),
  });
}

/**
 * The admission estimate of one call: {@link reservedCallParts} summed. A zero
 * ceiling is rejected — it would place a zero admission hold (free admission),
 * which is always a caller bug, never a legitimate run.
 */
export function estimateRunCeilingNanoUsd(
  pricing: ModelPricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): EstimateResult<bigint> {
  const parts = reservedCallParts(pricing, usage, ceiling, storage);
  if (!parts.ok) return parts;
  const amount = parts.value.providerNanoUsd + parts.value.storageNanoUsd;
  if (amount === 0n) {
    return estimateErr('invalid-request', 'Estimate run ceiling must be a positive amount');
  }
  return estimateOk(amount);
}
