/**
 * A call's cost as a function of its output ceiling. Each tool-loop step is its
 * own provider request, and a long-context tier applies to the whole of the
 * request whose prompt crosses it, so each step is priced at the tier its own
 * input bound resolves to. A later step re-sends every earlier output, so its
 * bound grows with the ceiling and it can enter a tier that earlier steps do
 * not: cost is linear in the ceiling only between those crossings. The curve
 * is that piecewise-linear function, one regime per stretch on which every
 * step's tier is fixed. It is evaluated at a cap, and solved for the largest
 * cap a funding buys.
 */

import { steppedCallLineItems, stepResentInput } from '../estimate/price-request.ts';
import { evaluateManifest, manifestParts } from '../estimate/reducers.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { mediaRatesFor, resolveTier, scheduleFor } from './schedule.ts';
import type { NanoLineItem } from '../estimate/types.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type {
  MediaPricing,
  PriceUse,
  TierIndex,
  TokenPriceSchedule,
  TokenPricing,
} from './schedule.ts';

/** One text call's bounded quantities. Its output ceiling is the curve's variable. */
export interface CallQuantities {
  readonly promptTokens: number;
  readonly loop?: ToolLoopBound;
  /** Whether the call's storage legs are reserved at all. */
  readonly persists: boolean;
  /** The input characters this call stores, priced as its input storage. */
  readonly newMessageChars: number;
}

export interface StepTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** From `fromOutputTokens` to the next regime's start, every step's tier is fixed and cost is one linear manifest. */
export interface CostRegime {
  readonly fromOutputTokens: number;
  readonly manifest: readonly NanoLineItem[];
  readonly stepTiers: readonly TierIndex[];
}

/**
 * Regimes ascending from 0, built up to `cap`, the most output tokens the
 * curve prices. Tiers past the cap were never resolved, so the curve refuses
 * to price or name the tiers of any output count above it.
 */
export interface CostCurve {
  readonly cap: number;
  readonly regimes: readonly CostRegime[];
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function stepsOf(quantities: CallQuantities): number {
  return quantities.loop?.steps ?? 1;
}

/** Step `step`'s input bound at output ceiling c: P + (k − 1)·c + [k ≥ 2]·C·r + [k ≤ S − 1]·o. */
export function stepInputBoundTokens(
  quantities: CallQuantities,
  step: number,
  outputCeilingTokens: number
): number {
  assertCount(outputCeilingTokens, 'stepInputBoundTokens: outputCeilingTokens');
  const resent = stepResentInput(quantities.loop, step);
  return (
    quantities.promptTokens +
    resent.earlierOutputs * outputCeilingTokens +
    resent.resultTokens +
    resent.overheadTokens
  );
}

/**
 * Where each regime starts: 0, and every output ceiling at which some step's
 * bound first exceeds some tier's threshold, up to the cap.
 */
function regimeStarts(
  schedule: TokenPriceSchedule,
  quantities: CallQuantities,
  maxOutputTokens: number
): readonly number[] {
  const starts = new Set<number>([0]);
  for (let step = 2; step <= stepsOf(quantities); step += 1) {
    const fixed = stepInputBoundTokens(quantities, step, 0);
    for (const tier of schedule.tiers) {
      const start =
        fixed > tier.abovePromptTokens
          ? 0
          : Math.floor((tier.abovePromptTokens - fixed) / (step - 1)) + 1;
      if (start <= maxOutputTokens) starts.add(start);
    }
  }
  return [...starts].toSorted((a, b) => a - b);
}

function regimeAt(
  schedule: TokenPriceSchedule,
  quantities: CallQuantities,
  fromOutputTokens: number
): CostRegime {
  const resolved = Array.from({ length: stepsOf(quantities) }, (_unused, index) =>
    resolveTier(schedule, stepInputBoundTokens(quantities, index + 1, fromOutputTokens))
  );
  const items = steppedCallLineItems(
    [
      {
        stepRates: resolved.map((step) => step.rates),
        ...(quantities.loop === undefined ? {} : { toolLoop: quantities.loop }),
      },
    ],
    BigInt(quantities.promptTokens),
    quantities.newMessageChars
  );
  return {
    fromOutputTokens,
    manifest: quantities.persists ? items : items.filter((item) => item.kind === 'provider'),
    stepTiers: resolved.map((step) => step.tier),
  };
}

export function textCallCurve(
  pricing: TokenPricing,
  use: PriceUse,
  quantities: CallQuantities,
  maxOutputTokens: number
): CostCurve {
  assertCount(quantities.promptTokens, 'textCallCurve: promptTokens');
  assertCount(quantities.newMessageChars, 'textCallCurve: newMessageChars');
  assertCount(maxOutputTokens, 'textCallCurve: maxOutputTokens');
  const schedule = scheduleFor(pricing, use);
  return {
    cap: maxOutputTokens,
    regimes: regimeStarts(schedule, quantities, maxOutputTokens).map((start) =>
      regimeAt(schedule, quantities, start)
    ),
  };
}

function assertPositiveCount(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function mediaGenerationNano(
  pricing: MediaPricing,
  use: PriceUse,
  call: { readonly images?: number; readonly seconds?: number; readonly resolution?: string }
): bigint {
  if (pricing.kind === 'perImage') {
    if (call.seconds !== undefined || call.resolution !== undefined) {
      throw new RangeError('mediaCallCurve: a per-image price takes an image count only');
    }
    return mediaRatesFor(pricing, use) * BigInt(assertPositiveCount(call.images, 'images'));
  }
  if (call.images !== undefined) {
    throw new RangeError('mediaCallCurve: a per-second price takes seconds, not images');
  }
  const seconds = assertPositiveCount(call.seconds, 'seconds');
  const rates = mediaRatesFor(pricing, use);
  const { resolution } = call;
  const rate =
    resolution !== undefined && Object.hasOwn(rates, resolution) ? rates[resolution] : undefined;
  if (rate === undefined) {
    throw new RangeError('mediaCallCurve: the price has no rate for the requested resolution');
  }
  return rate * BigInt(seconds);
}

/**
 * A media call's cost: one fixed regime with no steps. Its cost does not
 * depend on output tokens, so it is capped at the largest safe output count
 * and never lowers the cap of a sum it joins.
 */
export function mediaCallCurve(
  pricing: MediaPricing,
  use: PriceUse,
  call: { readonly images?: number; readonly seconds?: number; readonly resolution?: string }
): CostCurve {
  return {
    cap: Number.MAX_SAFE_INTEGER,
    regimes: [
      {
        fromOutputTokens: 0,
        manifest: [
          {
            label: 'media-generation',
            fixedNano: mediaGenerationNano(pricing, use, call),
            kind: 'provider',
          },
        ],
        stepTiers: [],
      },
    ],
  };
}

function regimeOf(curve: CostCurve, outputTokens: number): CostRegime {
  assertCount(outputTokens, 'outputTokens');
  if (outputTokens > curve.cap) {
    throw new RangeError('the curve prices no output count above its cap');
  }
  const regime = curve.regimes.findLast((entry) => entry.fromOutputTokens <= outputTokens);
  if (regime === undefined) {
    throw new RangeError('the curve has no regime at the requested output count');
  }
  return regime;
}

export function costAt(curve: CostCurve, outputTokens: number): NanoUSD {
  const regime = regimeOf(curve, outputTokens);
  return nanoUSD(
    evaluateManifest({ items: regime.manifest }, BigInt(outputTokens), { scope: 'all-in' })
  );
}

export function tiersAt(curve: CostCurve, outputTokens: number): readonly TierIndex[] {
  return regimeOf(curve, outputTokens).stepTiers;
}

/**
 * Several calls sharing one output ceiling: capped at the smallest of their
 * caps, with a regime wherever any of them starts one at or below it.
 */
export function sumCurves(curves: readonly CostCurve[]): CostCurve {
  if (curves.length === 0) throw new RangeError('sumCurves: at least one curve is required');
  const cap = Math.min(...curves.map((curve) => curve.cap));
  const starts = new Set(
    curves.flatMap((curve) => curve.regimes.map((regime) => regime.fromOutputTokens))
  );
  return {
    cap,
    regimes: [...starts]
      .filter((start) => start <= cap)
      .toSorted((a, b) => a - b)
      .map((fromOutputTokens) => {
        const parts = curves.map((curve) => regimeOf(curve, fromOutputTokens));
        return {
          fromOutputTokens,
          manifest: parts.flatMap((part) => part.manifest),
          stepTiers: parts.flatMap((part) => part.stepTiers),
        };
      }),
  };
}

/**
 * The largest output ceiling up to the curve's cap whose cost fits the
 * funding, or 0 when none does; funding for more than the cap buys the cap.
 * Cost never falls as the ceiling rises, so the regimes are scanned from the
 * highest down, and the first whose own start fits holds the answer: its
 * closed form, clamped to the regime's end, which for the top regime is the
 * cap.
 */
export function largestFundedOutput(curve: CostCurve, fundingNanoUsd: bigint): number {
  for (const [index, regime] of [...curve.regimes.entries()].toReversed()) {
    const { fixedNano, variableRateNano } = manifestParts({ items: regime.manifest });
    if (variableRateNano <= 0n) {
      throw new RangeError('largestFundedOutput: the curve has no positive per-output-token rate');
    }
    if (fixedNano + BigInt(regime.fromOutputTokens) * variableRateNano > fundingNanoUsd) continue;
    const funded = (fundingNanoUsd - fixedNano) / variableRateNano;
    const next = curve.regimes[index + 1];
    const end = next === undefined ? curve.cap : next.fromOutputTokens - 1;
    return funded > BigInt(end) ? end : Number(funded);
  }
  return 0;
}

/** The per-step kernel at observed usage: each step at the tier its own input resolves to. */
export function priceSteps(
  pricing: TokenPricing,
  use: PriceUse,
  steps: readonly StepTokens[]
): { readonly nanoUsd: NanoUSD; readonly tiers: readonly TierIndex[] } {
  const schedule = scheduleFor(pricing, use);
  let total = 0n;
  const tiers: TierIndex[] = [];
  for (const step of steps) {
    assertCount(step.outputTokens, 'priceSteps: outputTokens');
    const resolved = resolveTier(schedule, step.inputTokens);
    total +=
      BigInt(step.inputTokens) * resolved.rates.input +
      BigInt(step.outputTokens) * resolved.rates.output;
    tiers.push(resolved.tier);
  }
  return { nanoUsd: nanoUSD(total), tiers };
}

/**
 * A usage priced at the schedule's base rates whatever its input size: the
 * price of a call whose per-step split is unknown. Rates never fall from base
 * to a tier, so it never exceeds the per-step price of any split of the usage.
 */
export function priceAtBaseRates(pricing: TokenPricing, use: PriceUse, usage: StepTokens): NanoUSD {
  assertCount(usage.inputTokens, 'priceAtBaseRates: inputTokens');
  assertCount(usage.outputTokens, 'priceAtBaseRates: outputTokens');
  const { base } = scheduleFor(pricing, use);
  return nanoUSD(BigInt(usage.inputTokens) * base.input + BigInt(usage.outputTokens) * base.output);
}
