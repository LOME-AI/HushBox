/**
 * The wire hop, pinned where it lives. Its two call sites — the client's option
 * producer and the agreement test that draws the client's half — both import
 * this, so these cases are the only place the adaptation itself is described.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from './model-id.ts';
import { poolModelFromWire } from './wire-pool-row.ts';
import { TEST_DAY_START, secondsAt } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { Model } from '../../schemas/api/models.ts';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_MS = TEST_DAY_START;

function wireRowFor(overrides: Partial<Model> = {}): Model {
  return {
    id: 'vendor/model',
    name: 'Vendor Model',
    provider: 'vendor',
    modality: 'text',
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerToken: '300', outputPerToken: '1500' },
    description: 'a model',
    supportedParameters: [],
    created: FIXTURE_STAMP_SECONDS,
    ...overrides,
  };
}

describe('poolModelFromWire', () => {
  it('turns the wire row into a pool member, rates and all', () => {
    expect(poolModelFromWire(wireRowFor())).toEqual({
      modelId: modelId('vendor/model'),
      pricing: tokenPricingFixture({ input: 300n, output: 1500n }),
      contextLength: 200_000,
      providerCap: 64_000,
      releasedAtMs: FIXTURE_STAMP_MS,
      reasoning: undefined,
    });
  });

  it('drops the synthetic Smart Model row — it is the slot, not a member', () => {
    expect(poolModelFromWire(wireRowFor({ isSmartModel: true }))).toBeUndefined();
  });

  it('leaves an undeclared rate leg absent rather than pricing it as free', () => {
    expect(poolModelFromWire(wireRowFor({ pricing: { inputPerToken: '300' } }))).toBeUndefined();
    expect(poolModelFromWire(wireRowFor({ pricing: {} }))).toBeUndefined();
  });

  it('drops a row the wire serves a zero rate for — a rate the schedule cannot price', () => {
    const free = wireRowFor({ pricing: { inputPerToken: '0', outputPerToken: '1500' } });
    expect(poolModelFromWire(free)).toBeUndefined();
  });

  it('carries the row modality onto the shape leg, so a media row is no pool member', () => {
    expect(poolModelFromWire(wireRowFor({ modality: 'image' }))).toBeUndefined();
    expect(poolModelFromWire(wireRowFor({ modality: 'video' }))).toBeUndefined();
  });

  it('drops a row the catalog never dated', () => {
    expect(poolModelFromWire(wireRowFor({ created: undefined }))).toBeUndefined();
  });

  it('leaves the provider cap absent when the wire declares none', () => {
    expect(
      poolModelFromWire(wireRowFor({ maxOutputTokens: undefined }))?.providerCap
    ).toBeUndefined();
  });

  it('carries the reasoning metadata through verbatim', () => {
    const reasoning = { supportedEfforts: ['high', 'low'], mandatory: true };
    expect(poolModelFromWire(wireRowFor({ reasoning }))?.reasoning).toEqual(reasoning);
  });
});
