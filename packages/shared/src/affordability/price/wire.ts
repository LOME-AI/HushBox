/**
 * A parsed price's readings for the carriers around it: the served catalog row,
 * which carries the anchor's token rates with its long-context rates, or a
 * media model's anchor rate beside the dearest rate a hold reserves, as decimal
 * strings; and the narrowings a token or media consumer takes. A price read off
 * the wire is parsed through {@link ModelPricingSchema} like any other, so a
 * served row whose rates the schedule cannot represent has no price rather than
 * a free one.
 */

import { serializeNanoUSD } from '../money/nano-usd.ts';
import { mediaRatesFor, ModelPricingSchema, scheduleFor } from './schedule.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { Model, WireModelPricing } from '../../schemas/api/models.ts';
import type { MediaPricing, ModelPricing, PriceTier, TokenPricing } from './schedule.ts';

/** The unparsed price a served row states, or `undefined` for a modality no price kind represents. */
function statedPrice(model: Model): object | undefined {
  const { pricing } = model;
  switch (model.modality) {
    case 'text': {
      return {
        kind: 'tokens',
        anchor: {
          base: { input: pricing.inputPerToken, output: pricing.outputPerToken },
          tiers: (pricing.longContextRates ?? []).map((rate) => ({
            abovePromptTokens: rate.abovePromptTokens,
            rates: { input: rate.inputPerToken, output: rate.outputPerToken },
          })),
        },
      };
    }
    case 'image': {
      return { kind: 'perImage', anchor: pricing.perImage, dearest: pricing.dearestPerImage };
    }
    case 'video': {
      return {
        kind: 'perSecond',
        anchor: pricing.perSecondByResolution,
        dearest: pricing.dearestPerSecondByResolution,
      };
    }
    case 'audio': {
      return undefined;
    }
  }
}

/**
 * The price a served row states, parsed, or `undefined` when it states none the
 * schedule can represent. A media row that serves no dearest rate states no
 * price: the dearest side is what a hold reserves, and the anchor is not it.
 */
export function pricingFromWire(model: Model): ModelPricing | undefined {
  const stated = statedPrice(model);
  if (stated === undefined) return undefined;
  const parsed = ModelPricingSchema.safeParse(stated);
  return parsed.success ? parsed.data : undefined;
}

function serializedRates(rates: Readonly<Record<string, NanoUSD>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rates).map(([key, rate]) => [key, serializeNanoUSD(rate)])
  );
}

/** The long-context key, present only when the schedule has a tier, so an untiered row serves the two token keys alone. */
function servedTiers(tiers: readonly PriceTier[]): Pick<WireModelPricing, 'longContextRates'> {
  if (tiers.length === 0) return {};
  return {
    longContextRates: tiers.map((tier) => ({
      abovePromptTokens: tier.abovePromptTokens,
      inputPerToken: serializeNanoUSD(tier.rates.input),
      outputPerToken: serializeNanoUSD(tier.rates.output),
    })),
  };
}

/**
 * The served keys of a price: the rates a user is shown, as decimal strings,
 * and for media the dearest side beside them, written as that side itself so
 * {@link pricingFromWire} reads back the price it was given.
 */
export function pricingToWire(pricing: ModelPricing): WireModelPricing {
  switch (pricing.kind) {
    case 'tokens': {
      const { base, tiers } = scheduleFor(pricing, 'display');
      return {
        inputPerToken: serializeNanoUSD(base.input),
        outputPerToken: serializeNanoUSD(base.output),
        ...servedTiers(tiers),
      };
    }
    case 'perImage': {
      return {
        perImage: serializeNanoUSD(mediaRatesFor(pricing, 'display')),
        dearestPerImage: serializeNanoUSD(pricing.dearest),
      };
    }
    case 'perSecond': {
      return {
        perSecondByResolution: serializedRates(mediaRatesFor(pricing, 'display')),
        dearestPerSecondByResolution: serializedRates(pricing.dearest),
      };
    }
  }
}

/** The price as a token schedule, or `undefined` when it prices media. */
export function tokenPricingOf(pricing: ModelPricing): TokenPricing | undefined {
  return pricing.kind === 'tokens' ? pricing : undefined;
}

/** The price as a per-unit media price, or `undefined` when it prices tokens. */
export function mediaPricingOf(pricing: ModelPricing): MediaPricing | undefined {
  return pricing.kind === 'tokens' ? undefined : pricing;
}
