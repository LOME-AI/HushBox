/**
 * Builds a test's prices by parsing them through `ModelPricingSchema`. A
 * `ModelPricing` is branded, so a literal written field by field does not type
 * as one, and a price the schema refuses fails the test that builds it.
 *
 * Test-only.
 */

import { ModelPricingSchema } from '../affordability/price/schedule.ts';
import type { MediaPricing, ModelPricing, TokenPricing } from '../affordability/price/schedule.ts';

type PerImagePricing = Extract<MediaPricing, { kind: 'perImage' }>;

type PerSecondPricing = Extract<MediaPricing, { kind: 'perSecond' }>;

/** Parses a wire price and narrows it to `kind` with a checked predicate, where a cast would only assert. */
function parsedAs<Kind extends ModelPricing['kind']>(
  kind: Kind,
  wire: object
): Extract<ModelPricing, { kind: Kind }> {
  return ModelPricingSchema.refine(
    (pricing): pricing is Extract<ModelPricing, { kind: Kind }> => pricing.kind === kind
  ).parse({ ...wire, kind });
}

function rateRecord(rates: Readonly<Record<string, bigint>>): Record<string, string> {
  return Object.fromEntries(Object.entries(rates).map(([key, rate]) => [key, rate.toString()]));
}

export function tokenPricingFixture(input: {
  readonly input: bigint;
  readonly output: bigint;
  readonly tiers?: readonly {
    readonly abovePromptTokens: number;
    readonly input: bigint;
    readonly output: bigint;
  }[];
}): TokenPricing {
  return parsedAs('tokens', {
    anchor: {
      base: { input: input.input.toString(), output: input.output.toString() },
      tiers: (input.tiers ?? []).map((tier) => ({
        abovePromptTokens: tier.abovePromptTokens,
        rates: { input: tier.input.toString(), output: tier.output.toString() },
      })),
    },
  });
}

export function perImagePricingFixture(input: {
  readonly anchor: bigint;
  readonly dearest: bigint;
}): PerImagePricing {
  return parsedAs('perImage', {
    anchor: input.anchor.toString(),
    dearest: input.dearest.toString(),
  });
}

export function perSecondPricingFixture(input: {
  readonly anchor: Readonly<Record<string, bigint>>;
  readonly dearest: Readonly<Record<string, bigint>>;
}): PerSecondPricing {
  return parsedAs('perSecond', {
    anchor: rateRecord(input.anchor),
    dearest: rateRecord(input.dearest),
  });
}
