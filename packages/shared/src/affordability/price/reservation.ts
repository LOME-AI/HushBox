/**
 * What a run's hold reserves, call by call. The estimator returns it to the
 * engine, which admits on its total.
 */

import { evaluateManifest } from '../estimate/reducers.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { costAt, stepInputBoundTokens } from './curve.ts';
import { resolveTier, scheduleFor } from './schedule.ts';
import type { NanoLineItem } from '../estimate/types.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { CallQuantities, CostCurve } from './curve.ts';
import type { ModelPricing, TierIndex, TokenPricing, TokenRates } from './schedule.ts';

/** One call the hold reserves, with the quantities and tiers it was priced at. */
export interface ReservedCall {
  readonly nodeId: string;
  readonly modelId: string;
  readonly pricing: ModelPricing;
  readonly quantities: CallQuantities;
  readonly steps: number;
  /** The output ceiling each step was reserved at; 0 for a media call. */
  readonly wireCapTokens: number;
  readonly stepTiers: readonly TierIndex[];
  readonly providerNanoUsd: NanoUSD;
  readonly storageNanoUsd: NanoUSD;
  /** The call's whole share of the hold: its provider and storage parts. */
  readonly heldNanoUsd: NanoUSD;
  /**
   * Set on the routing-only classifier call a Smart Model slot reserves for
   * itself, beside its candidates under the same node. It answers nothing, so no
   * node's answer is priced or bounded by it.
   */
  readonly routingClassifier?: true;
}

/**
 * A run's hold: the total, and the calls whose held amounts add up to it. A run
 * with no call has nothing to carry its input storage, so there the total holds
 * that storage and `calls` is empty.
 */
export interface RunReservation {
  readonly totalNanoUsd: NanoUSD;
  readonly calls: readonly ReservedCall[];
}

/**
 * The answer call the hold reserved for a node — for one of its models when
 * `modelId` names one — and never a slot's routing classifier. Where it reserved
 * several, the one with the most steps, the first of equals: a loop's re-sent
 * tokens are what a call's input bound adds to its prompt, so a fewer-step call
 * would understate it.
 */
export function reservedCallFor(
  calls: readonly ReservedCall[],
  nodeId: string,
  modelId?: string
): ReservedCall | undefined {
  let chosen: ReservedCall | undefined;
  for (const call of calls) {
    if (call.nodeId !== nodeId || call.routingClassifier === true) continue;
    if (modelId !== undefined && call.modelId !== modelId) continue;
    if (chosen === undefined || call.steps > chosen.steps) chosen = call;
  }
  return chosen;
}

/**
 * The line items that price `outputTokens` on the curve: the manifest of the
 * regime it falls in. Refuses above the curve's cap, as the curve does.
 */
export function lineItemsAt(curve: CostCurve, outputTokens: number): readonly NanoLineItem[] {
  costAt(curve, outputTokens);
  const regime = curve.regimes.findLast((entry) => entry.fromOutputTokens <= outputTokens);
  /* v8 ignore next 3 -- unreachable: `costAt` has already found this regime */
  if (regime === undefined) {
    throw new RangeError('the curve has no regime at the requested output count');
  }
  return regime.manifest;
}

/** The curve's cost at `outputTokens`, split into its provider and storage parts. */
export function costPartsAt(
  curve: CostCurve,
  outputTokens: number
): { readonly providerNanoUsd: NanoUSD; readonly storageNanoUsd: NanoUSD } {
  const items = { items: lineItemsAt(curve, outputTokens) };
  const tokens = BigInt(outputTokens);
  const provider = evaluateManifest(items, tokens, { scope: 'provider-only' });
  const all = evaluateManifest(items, tokens, { scope: 'all-in' });
  return { providerNanoUsd: nanoUSD(provider), storageNanoUsd: nanoUSD(all - provider) };
}

/** The rates each step of a reserved call was held at: the ceiling at that step's tier. */
export function reservedStepRates(call: ReservedCall): readonly TokenRates[] {
  if (call.pricing.kind !== 'tokens') return [];
  const ceiling = scheduleFor(call.pricing, 'reserve');
  return call.stepTiers.map((tier) => {
    if (tier === 0) return ceiling.base;
    const reached = ceiling.tiers[tier - 1];
    /* v8 ignore next 3 -- unreachable: a step's tier was resolved on this schedule */
    if (reached === undefined) throw new RangeError('a step tier lies past the schedule');
    return reached.rates;
  });
}

/**
 * The most input tokens any step of a reserved call can send: its prompt's
 * UTF-8 bytes, which no token count exceeds, plus the output, tool results and
 * tool overhead the reservation lets that step re-send.
 */
export function callInputUpperBoundTokens(call: ReservedCall, promptUtf8Bytes: number): number {
  const quantities = { ...call.quantities, promptTokens: promptUtf8Bytes };
  let bound = 0;
  for (let step = 1; step <= call.steps; step += 1) {
    bound = Math.max(bound, stepInputBoundTokens(quantities, step, call.wireCapTokens));
  }
  return bound;
}

/**
 * The ceiling rates a call's `max_price` caps at: the anchor's own dearest
 * tier, and, when the call's input bound passes the anchor's context, the
 * dearest larger-context segment that bound reaches. The schedule is a
 * cumulative maximum, so both are the ceiling at the larger of the anchor's
 * context and the bound. A tier never needs the call's estimate to be admitted,
 * and a segment is decided on a bound that cannot fall short of the prompt.
 */
export function callCeilingRates(pricing: TokenPricing, inputTokenUpperBound: number): TokenRates {
  const reached = Math.max(pricing.anchorContextTokens, inputTokenUpperBound);
  return resolveTier(scheduleFor(pricing, 'reserve'), reached).rates;
}
