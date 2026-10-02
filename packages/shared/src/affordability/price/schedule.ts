/**
 * A model's price as one typed value: a token model's schedule of base rates
 * and long-context tiers, or a media model's per-unit rates. Every rate is
 * billable nano-USD, fee baked, and required, so an absent rate cannot be
 * represented.
 */

import { z } from 'zod';

import { NanoUSD, nanoUSD } from '../money/nano-usd.ts';

export interface TokenRates {
  readonly input: NanoUSD;
  readonly output: NanoUSD;
}

/**
 * Rates that apply to a whole request whose prompt tokens are strictly greater
 * than the threshold, as OpenRouter defines `min_prompt_tokens`.
 */
export interface PriceTier {
  readonly abovePromptTokens: number;
  readonly rates: TokenRates;
}

/** Base rates plus tiers, thresholds strictly ascending and rates never falling. */
export interface TokenPriceSchedule {
  readonly base: TokenRates;
  readonly tiers: readonly PriceTier[];
}

declare const tierIndexBrand: unique symbol;

/** 0 is the base rates; i ≥ 1 is `tiers[i − 1]`. */
export type TierIndex = number & { readonly [tierIndexBrand]: true };

/**
 * A token model carries its anchor schedule; a media model carries its anchor
 * and its dearest per-unit rates, because a hold reserves the dearest unit and
 * that cannot be derived from the anchor. Branded like `NanoUSD`:
 * {@link ModelPricingSchema} mints one, and a literal written field by field
 * does not type as one.
 */
export type ModelPricing = PricingShapes & z.$brand<'ModelPricing'>;

type PricingShapes =
  | { readonly kind: 'tokens'; readonly anchor: TokenPriceSchedule }
  | { readonly kind: 'perImage'; readonly anchor: NanoUSD; readonly dearest: NanoUSD }
  | {
      readonly kind: 'perSecond';
      readonly anchor: Readonly<Record<string, NanoUSD>>;
      readonly dearest: Readonly<Record<string, NanoUSD>>;
    };

export type TokenPricing = Extract<ModelPricing, { kind: 'tokens' }>;

export type MediaPricing = Exclude<ModelPricing, TokenPricing>;

type PerImagePricing = Extract<MediaPricing, { kind: 'perImage' }>;

type PerSecondPricing = Extract<MediaPricing, { kind: 'perSecond' }>;

/** What a price is asked for. A consumer names its use, never which side of the price it reads. */
export type PriceUse = 'display' | 'estimatedCharge' | 'reserve';

const PositiveNanoUsd = NanoUSD.refine((value) => value > 0n, {
  message: 'a rate must be a positive NanoUSD',
});

const TokenRatesSchema = z.object({ input: PositiveNanoUsd, output: PositiveNanoUsd });

const TokenPriceScheduleSchema = z
  .object({
    base: TokenRatesSchema,
    tiers: z.array(
      z.object({ abovePromptTokens: z.number().int().positive(), rates: TokenRatesSchema })
    ),
  })
  .superRefine((schedule, context) => {
    let below: PriceTier | undefined;
    for (const [index, tier] of schedule.tiers.entries()) {
      const belowRates = below?.rates ?? schedule.base;
      if (below !== undefined && tier.abovePromptTokens <= below.abovePromptTokens) {
        context.addIssue({
          code: 'custom',
          path: ['tiers', index, 'abovePromptTokens'],
          message: 'tier thresholds must be strictly ascending',
        });
      }
      if (tier.rates.input < belowRates.input || tier.rates.output < belowRates.output) {
        context.addIssue({
          code: 'custom',
          path: ['tiers', index, 'rates'],
          message: 'a tier rate must not fall below the rate beneath it',
        });
      }
      below = tier;
    }
  });

const PerSecondRatesSchema = z.record(z.string(), PositiveNanoUsd);

const DEAREST_BELOW_ANCHOR = 'a dearest rate must not fall below its anchor';

const PerImagePricingSchema = z
  .object({ kind: z.literal('perImage'), anchor: PositiveNanoUsd, dearest: PositiveNanoUsd })
  .refine((pricing) => pricing.dearest >= pricing.anchor, {
    path: ['dearest'],
    message: DEAREST_BELOW_ANCHOR,
  });

/**
 * The anchor prices at least one resolution, and every resolution it prices is
 * priced by the dearest side, at no less.
 */
const PerSecondPricingSchema = z
  .object({
    kind: z.literal('perSecond'),
    anchor: PerSecondRatesSchema.refine((rates) => Object.keys(rates).length > 0, {
      message: 'a per-second anchor must price at least one resolution',
    }),
    dearest: PerSecondRatesSchema,
  })
  .superRefine((pricing, context) => {
    for (const [resolution, anchor] of Object.entries(pricing.anchor)) {
      const dearest = Object.hasOwn(pricing.dearest, resolution)
        ? pricing.dearest[resolution]
        : undefined;
      if (dearest === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['dearest', resolution],
          message: 'the dearest side must price every resolution the anchor prices',
        });
      } else if (dearest < anchor) {
        context.addIssue({
          code: 'custom',
          path: ['dearest', resolution],
          message: DEAREST_BELOW_ANCHOR,
        });
      }
    }
  });

export const ModelPricingSchema: z.core.$ZodBranded<z.ZodType<PricingShapes>, 'ModelPricing'> = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('tokens'), anchor: TokenPriceScheduleSchema }),
    PerImagePricingSchema,
    PerSecondPricingSchema,
  ])
  .brand<'ModelPricing'>();

export interface ResolvedTier {
  readonly tier: TierIndex;
  readonly rates: TokenRates;
}

/**
 * The one tier resolver: the last tier whose threshold the prompt tokens
 * exceed strictly, or base when none does. Callers live inside the price core.
 */
export function resolveTier(schedule: TokenPriceSchedule, promptTokens: number): ResolvedTier {
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
    throw new RangeError('resolveTier: promptTokens must be a non-negative integer');
  }
  let index = 0;
  let rates = schedule.base;
  for (const [position, tier] of schedule.tiers.entries()) {
    if (promptTokens > tier.abovePromptTokens) {
      index = position + 1;
      rates = tier.rates;
    }
  }
  return { tier: index as TierIndex, rates };
}

/** The ceiling's multiple of the anchor, applied to every token rate of every tier. */
export const PRICE_CEILING_MULTIPLE: { readonly numerator: 5n; readonly denominator: 4n } = {
  numerator: 5n,
  denominator: 4n,
};

function ceilingRate(rate: NanoUSD): NanoUSD {
  const { numerator, denominator } = PRICE_CEILING_MULTIPLE;
  return nanoUSD((rate * numerator + denominator - 1n) / denominator);
}

function ceilingRates(rates: TokenRates): TokenRates {
  return { input: ceilingRate(rates.input), output: ceilingRate(rates.output) };
}

/**
 * The schedule a hold reserves at: each base and tier rate of the anchor times
 * {@link PRICE_CEILING_MULTIPLE}, rounded up, at the anchor's thresholds.
 * Derived at use time and never stored. Its input rate also covers a 5-minute
 * cache write listed at up to five quarters of the prompt rate.
 */
export function ceilingOf(schedule: TokenPriceSchedule): TokenPriceSchedule {
  return {
    base: ceilingRates(schedule.base),
    tiers: schedule.tiers.map((tier) => ({
      abovePromptTokens: tier.abovePromptTokens,
      rates: ceilingRates(tier.rates),
    })),
  };
}

/**
 * Which side of a model's price each use reads, one row per use and one column
 * per price kind. What a user is shown and what an estimated charge bills read
 * the anchor; a token reserve reads the anchor's ceiling, and a media reserve
 * the dearest unit.
 */
const PRICE_SIDES: Readonly<
  Record<
    PriceUse,
    {
      readonly tokens: (pricing: TokenPricing) => TokenPriceSchedule;
      readonly media: 'anchor' | 'dearest';
    }
  >
> = {
  display: { tokens: (pricing) => pricing.anchor, media: 'anchor' },
  estimatedCharge: { tokens: (pricing) => pricing.anchor, media: 'anchor' },
  reserve: { tokens: (pricing) => ceilingOf(pricing.anchor), media: 'dearest' },
};

export function scheduleFor(pricing: TokenPricing, use: PriceUse): TokenPriceSchedule {
  return PRICE_SIDES[use].tokens(pricing);
}

export function mediaRatesFor(pricing: PerImagePricing, use: PriceUse): NanoUSD;
export function mediaRatesFor(
  pricing: PerSecondPricing,
  use: PriceUse
): Readonly<Record<string, NanoUSD>>;
export function mediaRatesFor(
  pricing: MediaPricing,
  use: PriceUse
): NanoUSD | Readonly<Record<string, NanoUSD>>;
export function mediaRatesFor(
  pricing: MediaPricing,
  use: PriceUse
): NanoUSD | Readonly<Record<string, NanoUSD>> {
  return PRICE_SIDES[use].media === 'anchor' ? pricing.anchor : pricing.dearest;
}
