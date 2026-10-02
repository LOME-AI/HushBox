/**
 * The arithmetic vocabulary of `docs/BILLING.md` §Math & Terms, as one named
 * function per defined quantity. Every producer call site prices through these,
 * so a term can be changed in one place and nothing composes its own variant of
 * a formula the specification already fixes. Two terms live in the price core
 * rather than here: `inputTokens` is `inputTokensOf` over the prompt's
 * characters, and the per-token storage rate is `outputStorageNanoUsdPerToken`,
 * which prices every output-storage item.
 *
 * Two conventions the whole file rests on:
 *
 * - **Every term is read off a sibling's cost curve.** A non-persisting turn
 *   therefore carries no storage term anywhere, because {@link siblingCurve}
 *   prices no storage on such a turn and the cost, the line items and the money
 *   solve are all readings of what it returns.
 * - **A rate is never multiplied into a hold.** `moneyPerToken` requirements
 *   from the dimension registry are units, not amounts; an amount only exists
 *   once a ceiling is in hand, which is what {@link costNanoUsd} takes.
 *
 * Pure: no clock, no I/O, no randomness, and no content — counts, rates and
 * identifiers only.
 */

import { effectiveCompletionCap } from '../completion-cap.ts';
import { MINIMUM_OUTPUT_TOKENS, OUTLIER_COST_MULTIPLE } from '../constants.ts';
import { dimensionSupportFor } from '../dimensions/derive.ts';
import { cheapestEffortOption, EFFORT_DIMENSION } from '../dimensions/effort.ts';
import { mediaUnitsCostNanoUsd } from '../dimensions/media.ts';
import { charStorageNanoUsd } from '../estimate/storage-rate.ts';
import { nanoPercentile } from '../percentile.ts';
import { costAt, largestFundedOutput, sumCurves, textCallCurve } from '../price/curve.ts';
import { lineItemsAt } from '../price/reservation.ts';
import type { OptionId } from '../dimensions/index.ts';
import type { MediaCallQuantity } from '../dimensions/media.ts';
import type { MediaModel } from '../dimensions/media-model.ts';
import type { NanoLineItem } from '../estimate/types.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { CostCurve } from '../price/curve.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { PromptBasis } from './turn-types.ts';

/**
 * The cap of a curve the money solve reads. The solve asks only what the money
 * buys; the model's output cap and the prompt's context headroom clamp its
 * answer afterwards ({@link ceilingTokens}), so the curve prices every output
 * count rather than stopping at either.
 */
export const MONEY_SOLVE_CAP_TOKENS = Number.MAX_SAFE_INTEGER;

/**
 * `inputStorage` = `inputChars × storageRatePerChar`, counted once per turn, not
 * once per sibling. On a text turn it arrives through the first sibling's
 * curve, the only {@link CostContext} with non-zero `inputChars`, so a turn's
 * cost counts it exactly once. Zero on a turn that does not persist.
 *
 * The basis is the NEW message alone, never `promptCharsOf`: a turn stores one
 * new user message row, the system prompt never rests at all, and every history
 * character was stored and charged by the turn that wrote it. Pricing the
 * assembled prompt here would reserve a fee settlement can never charge, and it
 * would grow without bound with conversation length. The input-token leg is the
 * one that DOES price the whole prompt, because the provider does receive all
 * of it.
 */
export function inputStorageNanoUsd(basis: PromptBasis, persists: boolean): bigint {
  if (!persists) return 0n;
  return charStorageNanoUsd(basis.inputChars);
}

export interface CostContext {
  readonly inputTokens: number;
  /**
   * The prompt characters whose storage this sibling carries. Non-zero on the
   * FIRST sibling of a turn only: prompt storage is one charge per turn, and
   * settlement anchors it onto the first persisted content (§Multi-Model 1).
   */
  readonly inputChars: number;
  readonly persists: boolean;
  /** The sibling's tool loop, present exactly when it carries a tool. */
  readonly toolLoop?: ToolLoopBound;
}

/**
 * One sibling's cost curve up to `capTokens` output tokens: the ONE price
 * construction in the turn producer, straight from the price core, each step at
 * the tier its own input bound resolves to. The priced total, the line items a
 * surface can read and the money solve are readings of this one curve, never
 * separate derivations of the same amount.
 *
 * Storage is not priced on a turn that does not persist, and the prompt's
 * storage rides the sibling whose context carries its characters.
 */
export function siblingCurve(
  model: PriceableModel,
  context: CostContext,
  capTokens: number
): CostCurve {
  return textCallCurve(
    model.pricing,
    'reserve',
    {
      promptTokens: context.inputTokens,
      ...(context.toolLoop === undefined ? {} : { loop: context.toolLoop }),
      persists: context.persists,
      newMessageChars: context.persists ? context.inputChars : 0,
    },
    capTokens
  );
}

/** The line items that price a sibling's call at `outputTokens`. */
export function siblingLineItems(
  model: PriceableModel,
  context: CostContext,
  outputTokens: number
): readonly NanoLineItem[] {
  return lineItemsAt(siblingCurve(model, context, outputTokens), outputTokens);
}

/**
 * `cost(m, tokens)` — the sibling's curve at `tokens`: its input, each step's
 * output, this sibling's share of prompt storage when it carries one, its
 * framing, and its whole tool loop when it carries a tool. A non-persisting turn
 * carries no storage term.
 *
 * It DELEGATES to {@link siblingCurve} rather than multiplying rates itself:
 * pricing has one implementation, and a named term of §Cost that merely agreed
 * with it would be a second one (One Implementation, Shared).
 */
export function costNanoUsd(
  model: PriceableModel,
  outputTokens: number,
  context: CostContext
): bigint {
  return costAt(siblingCurve(model, context, outputTokens), outputTokens);
}

/** `contextHeadroom(m)` = `contextLength(m) − inputTokens`, never negative. */
export function contextHeadroomTokens(model: PriceableModel, inputTokens: number): number {
  return Math.max(0, model.contextLength - inputTokens);
}

/**
 * `budgetBuys` — the largest shared token count whose cost fits the funding once
 * the classifier reserve is set aside: every sibling's curve summed, solved at
 * one output count. With one sibling it is §Math & Terms' `budgetBuys(m)`; with
 * N it is the shared token count `T` of §Sharing one budget across siblings.
 * Funding that does not cover the costs fixed at no output buys nothing.
 */
export function budgetBuysTokens(
  fundingNanoUsd: bigint,
  siblingCurves: readonly CostCurve[],
  classifierReserveNanoUsd: bigint
): number {
  return largestFundedOutput(sumCurves(siblingCurves), fundingNanoUsd - classifierReserveNanoUsd);
}

interface CeilingBounds {
  readonly contextHeadroomTokens: number;
  /** `budgetBuys(m)` for a solo turn, the shared `T` for siblings. */
  readonly sharedTokens: number;
}

/**
 * `ceiling(m)` = `min(providerCap(m), contextHeadroom(m), budgetBuys(m))` — what
 * the model can emit, what the prompt leaves free, and what the money can buy.
 * An absent provider cap falls back to the context length, per §Model bounds.
 *
 * No product-chosen answer length appears here: a payer who can pay for a
 * model's full output capability gets it.
 */
export function ceilingTokens(model: PriceableModel, bounds: CeilingBounds): number {
  return Math.max(
    0,
    Math.min(effectiveCompletionCap(model), bounds.contextHeadroomTokens, bounds.sharedTokens)
  );
}

/**
 * The token count `maxCallCost(m)` prices: `min(providerCap(m),
 * contextHeadroom(m))` — what the model can physically emit and what the prompt
 * leaves free, with NO money bound. Dropping `budgetBuys` is what makes the
 * quantity balance-independent, and therefore what makes the outlier set
 * reproducible from the catalog and the prompt size alone.
 */
export function maxCallCostTokens(model: PriceableModel, inputTokens: number): number {
  return Math.max(
    0,
    Math.min(effectiveCompletionCap(model), contextHeadroomTokens(model, inputTokens))
  );
}

/**
 * What a call's cost depends on once the funding is out of it. Deliberately NOT a
 * full {@link CostContext}: `inputChars` has no place here, because §Cost defines
 * `cost(m, tokens)` without a prompt-storage term — that term is a once-per-turn
 * fixed cost, not part of what a call on `m` costs.
 */
export type CallCostBasis = Omit<CostContext, 'inputChars' | 'toolLoop'>;

/** {@link CallCostBasis} for a prompt of `inputTokens` on a turn that does or does not persist. */
export function callCostBasis(inputTokens: number, persists: boolean): CallCostBasis {
  return { inputTokens, persists };
}

/**
 * `maxCallCost(m)` = `cost(m, min(providerCap(m), contextHeadroom(m)))` — the
 * most a call on `m` could ever cost for this prompt. Money-only,
 * balance-independent and independent of the payer.
 *
 * It is the quantity the Smart Model pool is ORDERED by and the quantity the
 * outlier test measures, and those are the same number for one reason: the hold
 * is a `MAX` over the pool, so the most a call could cost is precisely what a
 * candidate's presence imposes on every other candidate (§Smart Model 1, 3).
 */
export function maxCallCostNanoUsd(model: PriceableModel, basis: CallCostBasis): bigint {
  return costNanoUsd(model, maxCallCostTokens(model, basis.inputTokens), {
    ...basis,
    inputChars: 0,
  });
}

/**
 * The priceable catalog pool of §Predicates: every model with a usable rate and
 * a usable cap FOR THIS PROMPT. A model the prompt leaves no room for has no
 * usable cap, so it leaves the pool rather than ranking at zero and dragging the
 * median down. A `PriceableModel` carries both rates by construction, so the cap
 * is the only test left to make.
 */
function priceablePool(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): readonly PriceableModel[] {
  return pool.filter((model) => maxCallCostTokens(model, basis.inputTokens) > 0);
}

/** The middle of the sample. Named so the percentile call reads as the median. */
const MEDIAN_PERCENTILE = 0.5;

/**
 * One priced sample: a row's identifier and the most a call on it could cost.
 * The median and the outlier test are defined over this pair alone, which is
 * what lets a token-priced pool and a per-unit-priced pool share one
 * implementation without either learning the other's cost formula.
 */
interface PricedSample {
  readonly modelId: string;
  readonly maxCallCostNanoUsd: bigint;
}

function medianOfSamples(samples: readonly PricedSample[]): bigint | undefined {
  return nanoPercentile(
    samples.map((sample) => sample.maxCallCostNanoUsd),
    MEDIAN_PERCENTILE
  );
}

function outliersOfSamples(samples: readonly PricedSample[]): ReadonlySet<string> {
  const median = medianOfSamples(samples);
  if (median === undefined) return new Set();
  const threshold = OUTLIER_COST_MULTIPLE * median;
  return new Set(
    samples.filter((sample) => sample.maxCallCostNanoUsd > threshold).map((s) => s.modelId)
  );
}

function tokenSamples(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): readonly PricedSample[] {
  return priceablePool(pool, basis).map((model) => ({
    modelId: model.modelId,
    maxCallCostNanoUsd: maxCallCostNanoUsd(model, basis),
  }));
}

/**
 * `median(maxCallCost)` over the priceable catalog pool — NOT over the eligible
 * pool. Taking it over the eligible set would make it balance-dependent: a
 * low-balance payer would compute a different median, a different exclusion set,
 * and a pool that is no longer reproducible from the catalog (§Smart Model 3).
 * `undefined` when nothing in the pool prices.
 */
export function medianMaxCallCostNanoUsd(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): bigint | undefined {
  return medianOfSamples(tokenSamples(pool, basis));
}

/**
 * `outlier(m)` — the ids whose `maxCallCost` exceeds `OUTLIER_COST_MULTIPLE ×
 * median(maxCallCost)`. STRICTLY greater, so a model sitting exactly at the
 * multiple stays in.
 *
 * These ids leave the classifier-selectable set only. Nothing here removes a
 * model from the product: an excluded model stays explicitly selectable, and the
 * exclusion exists because the hold is a `MAX` over the pool — an extreme
 * candidate is not a free option, it is an option that taxes the others
 * (§Smart Model 3).
 */
export function outlierModelIds(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): ReadonlySet<string> {
  return outliersOfSamples(tokenSamples(pool, basis));
}

/**
 * `maxCallCost(m)` for a PER-UNIT priced model: the cost of the reference
 * quantity — one image, or N seconds at a resolution.
 *
 * The quantity is the whole bound. No token-shaped bound applies: a media row
 * carries neither a context length nor a completion cap, so `min(providerCap,
 * contextHeadroom)` has no meaning for it, and a token bound leaking in here
 * would silently cap a long generation's cost. A quantity the model does not
 * price has no cost — reported as absent, never as a zero.
 */
export function maxMediaCallCostNanoUsd(
  model: MediaModel,
  quantity: MediaCallQuantity
): bigint | undefined {
  return mediaUnitsCostNanoUsd(model, quantity);
}

/**
 * A model the quantity does not price contributes no sample: it has no cost to
 * compare, and standing a zero in for it would drag the median down and make
 * every priced sibling look like an outlier against it.
 */
function mediaSamples(
  pool: readonly MediaModel[],
  quantity: MediaCallQuantity
): readonly PricedSample[] {
  return pool.flatMap((model) => {
    const maxCallCostNanoUsd = maxMediaCallCostNanoUsd(model, quantity);
    return maxCallCostNanoUsd === undefined ? [] : [{ modelId: model.modelId, maxCallCostNanoUsd }];
  });
}

/**
 * `median(maxCallCost)` over a per-unit-priced pool, at a reference quantity.
 *
 * A SEPARATE pool from the token one, never a merged sample: the two are
 * denominated differently (a per-image amount and a per-token call cost are not
 * comparable), and merging them would move the token pool's median — which the
 * premium price threshold and the classifier engine are both read off.
 */
export function medianMaxMediaCallCostNanoUsd(
  pool: readonly MediaModel[],
  quantity: MediaCallQuantity
): bigint | undefined {
  return medianOfSamples(mediaSamples(pool, quantity));
}

/** {@link outlierModelIds} over a per-unit-priced pool, at a reference quantity. */
export function mediaOutlierModelIds(
  pool: readonly MediaModel[],
  quantity: MediaCallQuantity
): ReadonlySet<string> {
  return outliersOfSamples(mediaSamples(pool, quantity));
}

/** Whether the model offers any rung of the effort dimension at all. */
function offersEffort(model: PriceableModel): boolean {
  return dimensionSupportFor(EFFORT_DIMENSION, model).options.length > 0;
}

/**
 * `B(m, e)` — the reasoning budget option `e` reserves out of `ceiling(m)`, read
 * from the dimension registry so the ladder has one home. A model that offers no
 * rung reserves nothing; on a model that does, an unoffered rung is a caller
 * defect and the registry throws rather than reporting a phantom zero.
 */
export function reasoningBudgetTokens(model: PriceableModel, option: OptionId): number {
  if (!offersEffort(model)) return 0;
  return Number(EFFORT_DIMENSION.requirement(model, option));
}

/**
 * `B(m, e) + MINIMUM_OUTPUT_TOKENS` — the smallest ceiling that lets `m` run
 * option `e` and still emit a minimum viable answer. The single home of the
 * quantity: {@link feasible} tests it, and a caller naming which of the
 * ceiling's three bounds refused reads the same number rather than re-adding it.
 *
 * An absent option means no rung applies — a model that offers nothing on the
 * dimension reserves nothing for it.
 */
export function requiredCeilingTokens(model: PriceableModel, option?: OptionId): number {
  const reserved = option === undefined ? 0 : reasoningBudgetTokens(model, option);
  return reserved + MINIMUM_OUTPUT_TOKENS;
}

/**
 * `feasible(m, e)` = `B(m, e) + MINIMUM_OUTPUT_TOKENS ≤ ceiling(m)` — the effort
 * leaves room for a minimum answer. One direction, and only one: a menu enables
 * a level ⟹ this returns true, which is what makes "a menu can never enable a
 * level the server refuses" structural rather than coordinated (§Reasoning
 * Effort 3). Enabling is a CONJUNCTION — the tier axis first, then whether the
 * rung resolves on the model at all, then this across EVERY sibling of the
 * arrangement — so a rung whose own budget fits can still be withheld because a
 * sibling starves.
 */
export function feasible(
  model: PriceableModel,
  option: OptionId | undefined,
  ceiling: number
): boolean {
  return requiredCeilingTokens(model, option) <= ceiling;
}

/**
 * `eligible(m)` = `ceiling(m) ≥ B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS`. Graded
 * on the resolved cheapest corner, never on an unreachable zero: a
 * mandatory-reasoning model whose ceiling fits a minimum answer but not its
 * lowest rung beside it is not eligible. `e_min(m)` comes from the dimension
 * registry rather than being re-derived here, and a model with no rung at all
 * yields `undefined` — the minimum answer alone.
 */
export function eligible(model: PriceableModel, ceiling: number): boolean {
  return feasible(model, cheapestEffortOption(model), ceiling);
}
