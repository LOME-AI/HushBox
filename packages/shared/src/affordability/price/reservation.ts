/**
 * What a run's hold reserves, call by call. The estimator returns it to the
 * engine, which admits on its total.
 */

import { evaluateManifest } from '../estimate/reducers.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { costAt } from './curve.ts';
import type { NanoLineItem } from '../estimate/types.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { CallQuantities, CostCurve } from './curve.ts';
import type { ModelPricing, TierIndex } from './schedule.ts';

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
