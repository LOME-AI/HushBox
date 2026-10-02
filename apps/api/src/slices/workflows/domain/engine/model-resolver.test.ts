import { describe, expect, it } from 'vitest';
import { textTag } from '@hushbox/shared';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { priceUsageBillableNanoUsd } from '../../../models/index.js';
import { createModelResolver } from './model-resolver.js';
import type { Modality, ModelDescriptor, Usage } from '@hushbox/shared';
import type { ModelPricingResolver } from '../../../models/index.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function descriptorWith(
  id: string,
  inputs: readonly Modality[],
  outputs: readonly Modality[],
  pricing: ModelDescriptor['pricing'] = tokenPricingFixture({ input: 1n, output: 1n })
): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: [...inputs],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing,
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

function resolverOver(descriptors: readonly ModelDescriptor[]): ModelPricingResolver {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return (modelId) => byId.get(modelId);
}

describe('createModelResolver', () => {
  it('binds a known representable model to its descriptor, derived ports, and pricer', () => {
    const descriptor = descriptorWith('answer-model', ['text'], ['text']);
    const resolver = createModelResolver(resolverOver([descriptor]));
    const binding = resolver.resolve('answer-model');
    expect(binding?.descriptor).toBe(descriptor);
    expect(binding?.ports).toEqual({ in: [textTag()], out: textTag() });
  });

  it('prices through the catalog billable pricer, adding no fee of its own', () => {
    const pricing: ModelDescriptor['pricing'] = tokenPricingFixture({ input: 2n, output: 3n });
    const descriptor = descriptorWith('priced-model', ['text'], ['text'], pricing);
    const resolver = createModelResolver(resolverOver([descriptor]));
    const step: Usage = { inputTokens: 10, outputTokens: 20 };
    const observed = { kind: 'perStep', steps: [step] } as const;
    const priced = resolver.resolve('priced-model')?.price(observed);
    expect(priced?._unsafeUnwrap()).toBe(
      priceUsageBillableNanoUsd(pricing, observed)._unsafeUnwrap()
    );
    expect(priced?._unsafeUnwrap()).toBe(80n);
  });

  it('fails closed on an unknown model id', () => {
    const resolver = createModelResolver(resolverOver([]));
    expect(resolver.resolve('missing')).toBeUndefined();
  });

  it('fails closed on a model whose modalities are unrepresentable as ports', () => {
    const descriptor = descriptorWith('embed-model', ['text'], ['embedding']);
    const resolver = createModelResolver(resolverOver([descriptor]));
    expect(resolver.resolve('embed-model')).toBeUndefined();
  });
});

describe('createModelResolver — deterministic media pricer', () => {
  it('prices an image call from the flat per-image catalog rate', () => {
    const pricing: ModelDescriptor['pricing'] = perImagePricingFixture({
      anchor: 40n,
      dearest: 40n,
    });
    const descriptor = descriptorWith('image-model', ['text'], ['image'], pricing);
    const resolver = createModelResolver(resolverOver([descriptor]));

    const priced = resolver.resolve('image-model')?.priceMedia?.({});

    expect(priced?._unsafeUnwrap()).toBe(40n);
  });

  it('fails closed when an image call requests more than one artifact', () => {
    const pricing: ModelDescriptor['pricing'] = perImagePricingFixture({
      anchor: 40n,
      dearest: 40n,
    });
    const descriptor = descriptorWith('image-model', ['text'], ['image'], pricing);
    const resolver = createModelResolver(resolverOver([descriptor]));

    const priced = resolver.resolve('image-model')?.priceMedia?.({ n: 2 });

    expect(priced?.isErr()).toBe(true);
  });

  it('prices a video call from the per-resolution matrix', () => {
    const pricing: ModelDescriptor['pricing'] = perSecondPricingFixture({
      anchor: { '720p': 5n },
      dearest: { '720p': 5n },
    });
    const descriptor = descriptorWith('video-model', ['text'], ['video'], pricing);
    const resolver = createModelResolver(resolverOver([descriptor]));

    const priced = resolver
      .resolve('video-model')
      ?.priceMedia?.({ resolution: '720p', durationSeconds: 4 });

    expect(priced?._unsafeUnwrap()).toBe(20n);
  });

  it('fails closed when priceMedia is asked to price a language model', () => {
    const descriptor = descriptorWith('text-model', ['text'], ['text']);
    const resolver = createModelResolver(resolverOver([descriptor]));

    const priced = resolver.resolve('text-model')?.priceMedia?.({});

    expect(priced?.isErr()).toBe(true);
  });
});
