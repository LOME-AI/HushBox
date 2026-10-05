/**
 * Why a settled bill exceeded its hold, read with the same core functions that
 * built the hold. Settlement charges a bill above its hold in full; these legs
 * only name which reserved bound the observed run broke.
 */

import { priceSteps, stepInputBoundTokens } from './curve.ts';
import { resolveTier, scheduleFor } from './schedule.ts';
import { reservedCallFor } from './reservation.ts';
import type { StepTokens } from './curve.ts';
import type { TierIndex } from './schedule.ts';
import type { ReservedCall, RunReservation } from './reservation.ts';

export type HoldOverrunLeg =
  | 'input-above-estimate'
  | 'output-above-wire-cap'
  | 'tier-crossed'
  | 'rate-above-ceiling'
  | 'storage-above-allowance'
  | 'unattributed';

/** What a call observed while it ran: each step's usage, and the tool fees inside its charge. */
export interface ObservedUsage {
  readonly stepUsages: readonly StepTokens[];
  readonly toolFeeNanoUsd: bigint;
}

/** The facts of one posted charge the legs read; a settlement charge is one. */
export interface BilledCharge {
  /** The producing node id, suffixed after `#` for a fan-out branch or an auxiliary generation. */
  readonly key: string;
  readonly modelId: string;
  readonly billableCostNanoUsd: bigint;
  readonly isEstimated: boolean;
  readonly storageFeeNanoUsd?: bigint;
  readonly observed?: ObservedUsage;
}

/** What the charges cost the payer: every billable cost and storage fee. */
export function billedNanoUsd(billed: readonly BilledCharge[]): bigint {
  return billed.reduce(
    (sum, charge) => sum + charge.billableCostNanoUsd + (charge.storageFeeNanoUsd ?? 0n),
    0n
  );
}

/**
 * A settlement charge key: the producing node id, then `#` and a segment for
 * each fan-out branch or auxiliary generation beneath it. `parentKey` is the key
 * with its last segment removed, absent for a node's own charge.
 */
export function parseChargeKey(key: string): {
  readonly nodeId: string;
  readonly parentKey?: string;
} {
  const first = key.indexOf('#');
  if (first === -1) return { nodeId: key };
  return { nodeId: key.slice(0, first), parentKey: key.slice(0, key.lastIndexOf('#')) };
}

/** A step past the reserved count is read against the last reserved step. */
function reservedStep(call: ReservedCall, index: number): number {
  return Math.min(index + 1, call.steps);
}

/** The tier a reserved call held `step` at; a call priced on its steps carries one per step. */
function reservedTier(call: ReservedCall, step: number): TierIndex {
  const tier = call.stepTiers[step - 1];
  if (tier === undefined)
    throw new RangeError('a reserved call lacks the tier of one of its steps');
  return tier;
}

/** The legs no model's price decides: each step's input against its bound, and its output against the wire cap. */
function boundLegs(call: ReservedCall, charge: BilledCharge, legs: Set<HoldOverrunLeg>): void {
  if (call.pricing.kind !== 'tokens') return;
  for (const [index, step] of (charge.observed?.stepUsages ?? []).entries()) {
    const reserved = reservedStep(call, index);
    if (step.inputTokens > stepInputBoundTokens(call.quantities, reserved, call.wireCapTokens)) {
      legs.add('input-above-estimate');
    }
    if (step.outputTokens > call.wireCapTokens) legs.add('output-above-wire-cap');
  }
}

/** Each step's input against the tier the call's own schedule reserved it at. */
function tierLegs(call: ReservedCall, charge: BilledCharge, legs: Set<HoldOverrunLeg>): void {
  const { pricing } = call;
  if (pricing.kind !== 'tokens') return;
  const ceiling = scheduleFor(pricing, 'reserve');
  for (const [index, step] of (charge.observed?.stepUsages ?? []).entries()) {
    const tier = reservedTier(call, reservedStep(call, index));
    if (resolveTier(ceiling, step.inputTokens).tier > tier) legs.add('tier-crossed');
  }
}

/**
 * The provider amount above what the call could cost at its ceiling: for text,
 * the observed steps each priced at the ceiling of the tier its own input
 * reaches, so a crossed tier does not also read as a rate; for media, the
 * reserved provider amount. An estimated charge priced itself, and a text
 * charge with no per-step usage has nothing to price.
 */
function rateAboveCeiling(call: ReservedCall, charge: BilledCharge): boolean {
  if (charge.isEstimated) return false;
  const provider = charge.billableCostNanoUsd - (charge.observed?.toolFeeNanoUsd ?? 0n);
  if (call.pricing.kind !== 'tokens') return provider > call.providerNanoUsd;
  if (charge.observed === undefined) return false;
  return provider > priceSteps(call.pricing, 'reserve', charge.observed.stepUsages).nanoUsd;
}

/**
 * The run's reserved storage. A run's media storage is reserved once, on its
 * first persisting call, so storage is compared across the whole run, never per
 * call; with no call to carry it, the total holds it alone.
 */
function reservedStorageNanoUsd(reservation: RunReservation): bigint {
  if (reservation.calls.length === 0) return reservation.totalNanoUsd;
  return reservation.calls.reduce((sum, call) => sum + call.storageNanoUsd, 0n);
}

/** Every leg whose bound the billed charges broke, sorted; `unattributed` when the bill exceeds the hold and none did. */
export function holdOverrunLegs(
  reservation: RunReservation,
  billed: readonly BilledCharge[]
): readonly HoldOverrunLeg[] {
  const legs = new Set<HoldOverrunLeg>();
  for (const charge of billed) {
    const { nodeId } = parseChargeKey(charge.key);
    const own = reservedCallFor(reservation.calls, nodeId, charge.modelId);
    // A charge whose model the hold reserved no answer call for at its node — a
    // Smart Model candidate cheaper than the dearest one its slot reserved —
    // reads its bounds off the node's answer call; its price legs, which only
    // its own model's schedule decides, are not evaluated.
    const call = own ?? reservedCallFor(reservation.calls, nodeId);
    if (call === undefined) continue;
    boundLegs(call, charge, legs);
    if (own === undefined) continue;
    tierLegs(own, charge, legs);
    if (rateAboveCeiling(own, charge)) legs.add('rate-above-ceiling');
  }
  const storage = billed.reduce((sum, charge) => sum + (charge.storageFeeNanoUsd ?? 0n), 0n);
  if (storage > reservedStorageNanoUsd(reservation)) legs.add('storage-above-allowance');
  if (legs.size === 0 && billedNanoUsd(billed) > reservation.totalNanoUsd) {
    legs.add('unattributed');
  }
  return [...legs].toSorted((a, b) => a.localeCompare(b));
}
