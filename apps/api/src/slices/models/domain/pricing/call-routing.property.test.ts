/**
 * A call's `max_price` composed with its hold. For any anchor schedule, any
 * anchor context and any reserved call, the ceiling every step of the call was
 * reserved at un-bakes to no more than the call's `max_price`, so no step's
 * reserved rate is refused; and an endpoint serving a step at or below that
 * step's un-baked ceiling bills no more than the step reserved, which is the
 * bake/un-bake bound applied at the tier's ceiling.
 *
 * Rates are drawn magnitude first, so the sub-nano corner where rounding
 * decides the bill is drawn as often as the dear one.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { textCallCurve } from '@hushbox/shared/affordability/price/curve';
import {
  callInputUpperBoundTokens,
  costPartsAt,
  reservedStepRates,
} from '@hushbox/shared/affordability/price/reservation';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { toolLoopBound } from '@hushbox/shared/affordability';
import { scheduleFor } from '@hushbox/shared/affordability/price/schedule';
import {
  billableRateToMaxPriceUsdPerMillion,
  providerUsdToBillableNanoUsd,
} from '../../../billing/index.js';
import { callMaxPrice } from './call-routing.js';
import type { CallQuantities } from '@hushbox/shared/affordability/price/curve';
import type { ReservedCall } from '@hushbox/shared/affordability/price/reservation';
import type { TokenPricing, TokenRates } from '@hushbox/shared/affordability/price/schedule';

/** The dearest billable rate drawn: 10⁶ nano-USD (a tenth of a cent) a token. */
const MAX_RATE_EXPONENT = 6;

/** The largest prompt or context drawn, in tokens. */
const MAX_TOKENS = 2_000_000;

/** A positive billable rate, its magnitude drawn before its value. */
const billableRates: fc.Arbitrary<bigint> = fc
  .integer({ min: 0, max: MAX_RATE_EXPONENT })
  .chain((exponent) => fc.bigInt({ min: 1n, max: 10n ** BigInt(exponent) }));

/**
 * An anchor schedule of up to three tiers, thresholds strictly ascending and
 * rates never falling, with the anchor's context drawn at a threshold, either
 * side of one, or past them all, so the own-tier and segment halves of the
 * rule are both reached.
 */
const tokenSchedules: fc.Arbitrary<TokenPricing> = fc
  .record({
    base: fc.record({ input: billableRates, output: billableRates }),
    steps: fc.array(
      fc.record({
        gap: fc.integer({ min: 1, max: MAX_TOKENS / 4 }),
        input: billableRates,
        output: billableRates,
      }),
      { maxLength: 3 }
    ),
  })
  .chain(({ base, steps }) => {
    let threshold = 0;
    let rates = base;
    const tiers = steps.map((step) => {
      threshold += step.gap;
      rates = {
        input: rates.input + step.input,
        output: rates.output + step.output,
      };
      return { abovePromptTokens: threshold, ...rates };
    });
    const edges = tiers.flatMap((tier) => [tier.abovePromptTokens, tier.abovePromptTokens + 1]);
    const anyContext = fc.integer({ min: 1, max: MAX_TOKENS });
    const anchorContexts =
      edges.length === 0 ? anyContext : fc.oneof(fc.constantFrom(...edges), anyContext);
    return anchorContexts.map((anchorContextTokens) =>
      tokenPricingFixture({ ...base, tiers, anchorContextTokens })
    );
  });

/** A call's quantities: its estimated prompt, a tool loop or none, and its output cap. */
const stepQuantities: fc.Arbitrary<{
  readonly quantities: CallQuantities;
  readonly wireCapTokens: number;
  readonly promptBytesOver: number;
}> = fc.record({
  quantities: fc
    .record({
      promptTokens: fc.integer({ min: 0, max: MAX_TOKENS }),
      calls: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
    })
    .map(({ promptTokens, calls }) => ({
      promptTokens,
      ...(calls === undefined ? {} : { loop: toolLoopBound(['webSearch'], calls) }),
      persists: false,
      newMessageChars: 0,
    })),
  wireCapTokens: fc.integer({ min: 1, max: 64_000 }),
  /** How far the prompt's UTF-8 bytes exceed its estimated tokens: never below. */
  promptBytesOver: fc.integer({ min: 0, max: MAX_TOKENS }),
});

/**
 * What an endpoint serves one step: its rate as a fraction of the step's
 * un-baked ceiling, the ceiling itself drawn deliberately, and the step's
 * input and output tokens.
 */
const servedSteps = fc.record({
  fraction: fc.oneof(
    { arbitrary: fc.constant(1), weight: 1 },
    { arbitrary: fc.double({ min: 0, max: 1, noNaN: true }), weight: 2 }
  ),
  inputTokens: fc.integer({ min: 1, max: MAX_TOKENS }),
  outputTokens: fc.integer({ min: 1, max: 64_000 }),
});

function reservedCallOf(
  pricing: TokenPricing,
  quantities: CallQuantities,
  wireCapTokens: number
): ReservedCall {
  const curve = textCallCurve(pricing, 'reserve', quantities, wireCapTokens);
  const regime = curve.regimes.at(-1);
  if (regime === undefined) throw new Error('a curve has a regime from 0');
  const parts = costPartsAt(curve, wireCapTokens);
  return {
    nodeId: 'node',
    modelId: 'vendor/model',
    pricing,
    quantities,
    steps: quantities.loop?.steps ?? 1,
    wireCapTokens,
    stepTiers: regime.stepTiers,
    ...parts,
    heldNanoUsd: nanoUSD(parts.providerNanoUsd + parts.storageNanoUsd),
  };
}

/** A `max_price` string read back as pico-USD a token. */
function picoOf(usdPerMillion: string): bigint {
  return BigInt(usdPerMillion.replace('.', ''));
}

function unbakedPico(rates: TokenRates): { readonly input: bigint; readonly output: bigint } {
  return {
    input: picoOf(billableRateToMaxPriceUsdPerMillion(rates.input)),
    output: picoOf(billableRateToMaxPriceUsdPerMillion(rates.output)),
  };
}

function usdOfPico(pico: bigint): number {
  const digits = pico.toString().padStart(13, '0');
  return Number(`${digits.slice(0, -12)}.${digits.slice(-12)}`);
}

describe('a call routed under its max_price', () => {
  it('reserves no step at a ceiling its max_price refuses', () => {
    fc.assert(
      fc.property(tokenSchedules, stepQuantities, (pricing, drawn) => {
        const call = reservedCallOf(pricing, drawn.quantities, drawn.wireCapTokens);
        const bound = callInputUpperBoundTokens(
          call,
          drawn.quantities.promptTokens + drawn.promptBytesOver
        );
        const cap = callMaxPrice(pricing, bound);
        for (const rates of reservedStepRates(call)) {
          const ceiling = unbakedPico(rates);
          expect(ceiling.input).toBeLessThanOrEqual(picoOf(cap.prompt));
          expect(ceiling.output).toBeLessThanOrEqual(picoOf(cap.completion));
        }
      })
    );
  });

  it('caps at or above the un-baked ceiling of the base and of every tier the anchor’s context or the call’s bound passes', () => {
    fc.assert(
      fc.property(tokenSchedules, stepQuantities, (pricing, drawn) => {
        const call = reservedCallOf(pricing, drawn.quantities, drawn.wireCapTokens);
        const bound = callInputUpperBoundTokens(
          call,
          drawn.quantities.promptTokens + drawn.promptBytesOver
        );
        const cap = callMaxPrice(pricing, bound);
        const reach = Math.max(pricing.anchorContextTokens, bound);
        const ceiling = scheduleFor(pricing, 'reserve');
        const passed = ceiling.tiers.filter((tier) => tier.abovePromptTokens < reach);
        for (const rates of [ceiling.base, ...passed.map((tier) => tier.rates)]) {
          const unbaked = unbakedPico(rates);
          expect(unbaked.input).toBeLessThanOrEqual(picoOf(cap.prompt));
          expect(unbaked.output).toBeLessThanOrEqual(picoOf(cap.completion));
        }
      })
    );
  });

  it('bills a step served at or below its tier’s un-baked ceiling no more than the step reserved', () => {
    fc.assert(
      fc.property(
        tokenSchedules,
        stepQuantities,
        servedSteps,
        (pricing, drawn, { fraction, inputTokens, outputTokens }) => {
          const call = reservedCallOf(pricing, drawn.quantities, drawn.wireCapTokens);
          for (const rates of reservedStepRates(call)) {
            const ceiling = unbakedPico(rates);
            const served = (pico: bigint): bigint =>
              fraction === 1 ? pico : BigInt(Math.floor(Number(pico) * fraction));
            const costPico =
              served(ceiling.input) * BigInt(inputTokens) +
              served(ceiling.output) * BigInt(outputTokens);
            const reserved =
              rates.input * BigInt(inputTokens) + rates.output * BigInt(outputTokens);
            expect(providerUsdToBillableNanoUsd(usdOfPico(costPico))).toBeLessThanOrEqual(reserved);
          }
        }
      )
    );
  });
});
