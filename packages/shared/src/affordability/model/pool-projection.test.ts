import { describe, expect, it } from 'vitest';

import { modelId } from './model-id.ts';
import { poolModelFrom, poolModelFromDescriptor } from './pool-projection.ts';
import { TEST_DAY_START, secondsAt } from '../../testing/test-time.ts';
import { perImagePricingFixture, tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { ModelDescriptor } from './model-descriptor.ts';
import type { PoolCandidateRow } from './pool-projection.ts';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_MS = TEST_DAY_START;

function rowFor(overrides: Partial<PoolCandidateRow> = {}): PoolCandidateRow {
  return {
    id: 'vendor/model',
    inputs: ['text'],
    outputs: ['text'],
    pricing: tokenPricingFixture({ input: 300n, output: 1500n }),
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    reasoning: undefined,
    releasedAtSeconds: FIXTURE_STAMP_SECONDS,
    ...overrides,
  };
}

describe('poolModelFrom', () => {
  it('projects a text row the money layer can price', () => {
    expect(poolModelFrom(rowFor())).toEqual({
      modelId: modelId('vendor/model'),
      pricing: tokenPricingFixture({ input: 300n, output: 1500n }),
      contextLength: 200_000,
      providerCap: 64_000,
      releasedAtMs: FIXTURE_STAMP_MS,
      reasoning: undefined,
    });
  });

  it('keeps a vision row: extra INPUT modalities still run as a text turn', () => {
    expect(poolModelFrom(rowFor({ inputs: ['text', 'image'] }))).not.toBeUndefined();
  });

  it('drops a row whose runnable shape the engine cannot run as a text turn', () => {
    expect(poolModelFrom(rowFor({ outputs: ['image'] }))).toBeUndefined();
    expect(poolModelFrom(rowFor({ outputs: ['text', 'image'] }))).toBeUndefined();
    expect(poolModelFrom(rowFor({ inputs: ['image'] }))).toBeUndefined();
  });

  it('drops a row with no usable context length', () => {
    expect(poolModelFrom(rowFor({ contextLength: undefined }))).toBeUndefined();
    expect(poolModelFrom(rowFor({ contextLength: 0 }))).toBeUndefined();
  });

  it('drops a row carrying no release date', () => {
    expect(poolModelFrom(rowFor({ releasedAtSeconds: undefined }))).toBeUndefined();
  });

  it('drops a row whose price is not a token schedule', () => {
    const perImage = perImagePricingFixture({ anchor: 300n, dearest: 300n });
    expect(poolModelFrom(rowFor({ pricing: perImage }))).toBeUndefined();
  });

  it('drops a row whose caps are not whole numbers of tokens', () => {
    // Flooring one here is what let the two carriers disagree: the served wire
    // row refuses a non-integer cap outright, so a floored row would sit in the
    // server pool and in no client pool.
    expect(poolModelFrom(rowFor({ contextLength: 1000.5 }))).toBeUndefined();
    expect(poolModelFrom(rowFor({ maxOutputTokens: 500.5 }))).toBeUndefined();
  });
});

describe('poolModelFromDescriptor', () => {
  function descriptorFor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
    return {
      id: 'vendor/model',
      provider: 'vendor',
      version: '3',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: ['streaming'],
      limits: { contextLength: 200_000, maxOutputTokens: 64_000 },
      pricing: tokenPricingFixture({ input: 300n, output: 1500n }),
      zdrReachable: true,
      releasedAt: FIXTURE_STAMP_SECONDS,
      fetchedAt: 0,
      ...overrides,
    };
  }

  it('projects a descriptor exactly as its pool row projects', () => {
    expect(poolModelFromDescriptor(descriptorFor())).toEqual(poolModelFrom(rowFor()));
  });

  it('reads the provider cap from the descriptor limits', () => {
    expect(poolModelFromDescriptor(descriptorFor())?.providerCap).toBe(64_000);
  });

  it('carries the descriptor reasoning metadata onto the pool member', () => {
    const reasoning: ModelDescriptor['reasoning'] = { supportedEfforts: ['low', 'high'] };
    expect(poolModelFromDescriptor(descriptorFor({ reasoning }))?.reasoning).toEqual(reasoning);
  });

  it('drops a descriptor whose price is not a token schedule', () => {
    const pricing = perImagePricingFixture({ anchor: 40n, dearest: 40n });
    expect(poolModelFromDescriptor(descriptorFor({ pricing }))).toBeUndefined();
  });
});
