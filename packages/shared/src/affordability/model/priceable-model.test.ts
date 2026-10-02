import { describe, expect, it } from 'vitest';

import { modelId } from './model-id.ts';
import { DAY_MS, SECOND_MS, TEST_DAY_START, secondsAt } from '../../testing/test-time.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { priceableModelFrom, reasoningPlanModelOf } from './priceable-model.ts';
import { perImagePricingFixture, tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { ModelDescriptor } from './model-descriptor.ts';
import type { PriceableModel } from './priceable-model.ts';

/**
 * A release date and the catalog fetch that saw it, 100 seconds later. Nothing
 * in this file reads either against a clock; only their order is meaningful.
 */
const RELEASED_AT_SECONDS = secondsAt(TEST_DAY_START);
const FETCHED_AT_SECONDS = secondsAt(TEST_DAY_START + 100 * SECOND_MS);

function descriptorFor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'vendor/model',
    provider: 'vendor',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 200_000, maxOutputTokens: 64_000 },
    pricing: tokenPricingFixture({ input: 300n, output: 1500n }),
    zdrReachable: true,
    releasedAt: RELEASED_AT_SECONDS,
    fetchedAt: FETCHED_AT_SECONDS,
    ...overrides,
  };
}

describe('priceableModelFrom', () => {
  it('projects the money inputs off a catalog descriptor', () => {
    expect(priceableModelFrom(descriptorFor())).toEqual({
      modelId: modelId('vendor/model'),
      pricing: tokenPricingFixture({ input: 300n, output: 1500n }),
      contextLength: 200_000,
      providerCap: 64_000,
      releasedAtMs: TEST_DAY_START,
      reasoning: undefined,
    });
  });

  it('converts the catalog release date from seconds into milliseconds', () => {
    // The catalog dates a model in seconds and premium classification compares
    // milliseconds; a projection that skipped the conversion would date every
    // model in 1970 and no model would ever classify premium by recency.
    const otherReleaseMs = TEST_DAY_START - 500 * DAY_MS;
    expect(
      priceableModelFrom(descriptorFor({ releasedAt: secondsAt(otherReleaseMs) }))?.releasedAtMs
    ).toBe(otherReleaseMs);
  });

  it('carries the reasoning metadata through verbatim', () => {
    const reasoning = { supportedEfforts: ['high', 'low'], mandatory: true };
    expect(priceableModelFrom(descriptorFor({ reasoning }))?.reasoning).toEqual(reasoning);
  });

  it('leaves providerCap absent when the catalog declares no usable completion cap', () => {
    const projected = priceableModelFrom(
      descriptorFor({ limits: { contextLength: 8192, maxOutputTokens: 0 } })
    );
    expect(projected?.providerCap).toBeUndefined();
  });

  it('refuses a descriptor priced by a media unit — an unpriceable model, never a zero', () => {
    const perImage = perImagePricingFixture({ anchor: 300n, dearest: 300n });
    expect(priceableModelFrom(descriptorFor({ pricing: perImage }))).toBeUndefined();
  });

  it('refuses a descriptor with no declared context length', () => {
    expect(priceableModelFrom(descriptorFor({ limits: {} }))).toBeUndefined();
  });

  it('does not widen when the catalog grows a field', () => {
    const projected = priceableModelFrom(descriptorFor({ popularityRank: 3, name: 'Model' }));
    expect(Object.keys(projected ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'contextLength',
      'modelId',
      'pricing',
      'providerCap',
      'reasoning',
      'releasedAtMs',
    ]);
  });
});

describe('reasoningPlanModelOf', () => {
  it('maps the projection onto the reasoning plan input', () => {
    const model: PriceableModel = {
      modelId: modelId('vendor/model'),
      pricing: tokenPricingFixture({ input: nanoUSD(300n), output: nanoUSD(1500n) }),
      contextLength: 200_000,
      providerCap: 64_000,
      releasedAtMs: 0,
      reasoning: { supportedEfforts: null },
    };
    expect(reasoningPlanModelOf(model)).toEqual({
      reasoning: { supportedEfforts: null },
      contextLength: 200_000,
      maxOutputTokens: 64_000,
    });
  });
});
