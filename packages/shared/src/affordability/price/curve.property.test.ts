/**
 * The price core's laws over generated schedules and calls. Tier
 * monotonicity: a longer prompt never resolves to a cheaper tier, and a larger
 * output ceiling never costs less. The inverse: the largest funded output is
 * exactly what an exhaustive search over the output counts finds, where each
 * count's cost is priced step by step at observed-usage rates rather than read
 * back from the curve, so a regime that starts one token early or late is a
 * disagreement. The base-rate fallback: a usage priced at base rates never
 * exceeds the per-step price of any split of it into steps.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import { TOOL_CALL_CAP_MAX, toolLoopBound } from '../tool-loop.ts';
import {
  costAt,
  largestFundedOutput,
  priceAtBaseRates,
  priceSteps,
  stepInputBoundTokens,
  textCallCurve,
} from './curve.ts';
import { resolveTier } from './schedule.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { CallQuantities } from './curve.ts';
import type { TokenPricing } from './schedule.ts';

const TIER_THRESHOLDS = [128_000, 200_000, 272_000] as const;

/** A rate multiple from 1 to 2, in basis points. */
const multiple = fc.integer({ min: 10_000, max: 20_000 });

/**
 * A token price: base rates from 50 to 80,000 nano, and up to two tiers at the
 * live thresholds, each rate its base times a multiple from 1 to 2 that never
 * falls from one tier to the next.
 */
const tokenPricingArb: fc.Arbitrary<TokenPricing> = fc
  .record({
    input: fc.bigInt({ min: 50n, max: 80_000n }),
    output: fc.bigInt({ min: 50n, max: 80_000n }),
    thresholds: fc.subarray([...TIER_THRESHOLDS], { maxLength: 2 }),
    inputMultiples: fc.array(multiple, { minLength: 2, maxLength: 2 }),
    outputMultiples: fc.array(multiple, { minLength: 2, maxLength: 2 }),
  })
  .map(({ input, output, thresholds, inputMultiples, outputMultiples }) => {
    const ascending = (values: readonly number[]): readonly bigint[] =>
      values.toSorted((a, b) => a - b).map(BigInt);
    const inMultiples = ascending(inputMultiples);
    const outMultiples = ascending(outputMultiples);
    const scaled = (rate: bigint, basisPoints: bigint): bigint =>
      (rate * basisPoints + 9999n) / 10_000n;
    return tokenPricingFixture({
      input,
      output,
      tiers: thresholds.map((abovePromptTokens, index) => ({
        abovePromptTokens,
        input: scaled(input, inMultiples[index]!),
        output: scaled(output, outMultiples[index]!),
      })),
    });
  });

/** A prompt token count, drawn at each threshold and one either side as often as anywhere else. */
const promptTokensArb = fc.oneof(
  fc.constantFrom(
    ...TIER_THRESHOLDS.flatMap((threshold) => [threshold - 1, threshold, threshold + 1])
  ),
  fc.integer({ min: 0, max: 400_000 })
);

/** Two counts in ascending order. */
function ascendingPair([a, b]: readonly [number, number]): readonly [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/** Two prompt token counts, the first no larger than the second. */
const promptTokenPairsArb = fc
  .tuple(promptTokensArb, promptTokensArb)
  .map((pair) => ascendingPair(pair));

/** A tool loop at any call budget a turn can declare, or none. */
const loopArb: fc.Arbitrary<ToolLoopBound | undefined> = fc.option(
  fc
    .integer({ min: 1, max: TOOL_CALL_CAP_MAX })
    .map((calls) => toolLoopBound(['webSearch'], calls)),
  { nil: undefined }
);

function quantitiesOf(
  promptTokens: number,
  loop: ToolLoopBound | undefined,
  persists: boolean,
  newMessageChars: number
): CallQuantities {
  return { promptTokens, ...(loop === undefined ? {} : { loop }), persists, newMessageChars };
}

/** One text call and its cap, with prompts reaching past every threshold. */
const callArb = fc.record({
  pricing: tokenPricingArb,
  quantities: fc
    .tuple(promptTokensArb, loopArb, fc.boolean(), fc.integer({ min: 0, max: 20_000 }))
    .map(([promptTokens, loop, persists, chars]) =>
      quantitiesOf(promptTokens, loop, persists, chars)
    ),
  cap: fc.integer({ min: 0, max: 200_000 }),
});

/** Two output counts no larger than the cap, the first no larger than the second. */
function outputTokenPairsArb(cap: number): fc.Arbitrary<readonly [number, number]> {
  return fc
    .tuple(fc.integer({ min: 0, max: cap }), fc.integer({ min: 0, max: cap }))
    .map((pair) => ascendingPair(pair));
}

/**
 * A curve small enough to search exhaustively, with a cap of at most 5,000.
 * When the schedule has a tier and the call has a loop, three times in four
 * the prompt sits below one of the tier thresholds by at least the loop's
 * re-sent results and by less than those results plus one output cap per
 * call. From there the last step starts at or below the threshold and passes
 * it by the time the output ceiling reaches the cap. Otherwise the prompt is
 * uniform. The call does not persist, so each output count's cost is the
 * per-step kernel's price plus the call fees.
 */
const smallCurveArb = fc
  .record({
    pricing: tokenPricingArb,
    loop: loopArb,
    cap: fc.integer({ min: 1, max: 5000 }),
    fundingShare: fc.integer({ min: 0, max: 12_000 }),
  })
  .chain((call) => {
    const thresholds = call.pricing.anchor.tiers.map((tier) => tier.abovePromptTokens);
    const loop = call.loop;
    const uniform = { arbitrary: fc.integer({ min: 0, max: 300_000 }), weight: 1 };
    const crossing =
      thresholds.length === 0 || loop === undefined
        ? []
        : [
            {
              arbitrary: fc
                .tuple(
                  fc.constantFrom(...thresholds),
                  fc.integer({
                    min: loop.calls * loop.resultTokens,
                    max: loop.calls * (loop.resultTokens + call.cap) - 1,
                  })
                )
                .map(([threshold, below]) => threshold - below),
              weight: 3,
            },
          ];
    return fc.record({
      pricing: fc.constant(call.pricing),
      promptTokens: fc.oneof(uniform, ...crossing),
      loop: fc.constant(loop),
      cap: fc.constant(call.cap),
      fundingShare: fc.constant(call.fundingShare),
    });
  });

describe('tier monotonicity', () => {
  it('never resolves a longer prompt to a lower tier or a cheaper rate', () => {
    fc.assert(
      fc.property(tokenPricingArb, promptTokenPairsArb, (pricing, [shorter, longer]) => {
        const low = resolveTier(pricing.anchor, shorter);
        const high = resolveTier(pricing.anchor, longer);
        expect(high.tier).toBeGreaterThanOrEqual(low.tier);
        expect(high.rates.input).toBeGreaterThanOrEqual(low.rates.input);
        expect(high.rates.output).toBeGreaterThanOrEqual(low.rates.output);
      })
    );
  });

  it('never costs less at a larger output ceiling', () => {
    fc.assert(
      fc.property(
        callArb.chain((call) => fc.tuple(fc.constant(call), outputTokenPairsArb(call.cap))),
        ([call, [smaller, larger]]) => {
          const curve = textCallCurve(call.pricing, 'reserve', call.quantities, call.cap);
          expect(costAt(curve, larger)).toBeGreaterThanOrEqual(costAt(curve, smaller));
        }
      )
    );
  });
});

describe('the largest funded output', () => {
  it('equals an exhaustive search over the per-step kernel’s prices', () => {
    fc.assert(
      fc.property(smallCurveArb, ({ pricing, promptTokens, loop, cap, fundingShare }) => {
        const quantities = quantitiesOf(promptTokens, loop, false, 0);
        const curve = textCallCurve(pricing, 'reserve', quantities, cap);
        const fees = loop === undefined ? 0n : BigInt(loop.calls) * loop.callFeeNano;
        const steps = loop?.steps ?? 1;
        const kernelCost = (outputTokens: number): bigint =>
          priceSteps(
            pricing,
            'reserve',
            Array.from({ length: steps }, (_unused, index) => ({
              inputTokens: stepInputBoundTokens(quantities, index + 1, outputTokens),
              outputTokens,
            }))
          ).nanoUsd + fees;
        const costs = Array.from({ length: cap + 1 }, (_unused, outputTokens) =>
          kernelCost(outputTokens)
        );
        const funding = (costs[cap]! * BigInt(fundingShare)) / 10_000n;

        const disagreeing = costs.findIndex(
          (cost, outputTokens) => costAt(curve, outputTokens) !== cost
        );
        expect(disagreeing).toBe(-1);
        const searched = costs.findLastIndex((cost) => cost <= funding);
        expect(largestFundedOutput(curve, funding)).toBe(Math.max(searched, 0));
      })
    );
  });
});

/** One observed step: a prompt drawn at and around each threshold, and an output of up to 20,000 tokens. */
const observedStepArb = fc.record({
  inputTokens: promptTokensArb,
  outputTokens: fc.integer({ min: 0, max: 20_000 }),
});

/** A call's observed steps: one to eight of {@link observedStepArb}. */
const observedSplitArb = fc.array(observedStepArb, { minLength: 1, maxLength: 8 });

describe('the base-rate fallback', () => {
  it('never prices a summed usage above the per-step price of any split of it (generators: tokenPricingArb, observedSplitArb)', () => {
    fc.assert(
      fc.property(tokenPricingArb, observedSplitArb, (pricing, steps) => {
        const summed = {
          inputTokens: steps.reduce((total, step) => total + step.inputTokens, 0),
          outputTokens: steps.reduce((total, step) => total + step.outputTokens, 0),
        };
        expect(priceAtBaseRates(pricing, 'estimatedCharge', summed)).toBeLessThanOrEqual(
          priceSteps(pricing, 'estimatedCharge', steps).nanoUsd
        );
      })
    );
  });
});
