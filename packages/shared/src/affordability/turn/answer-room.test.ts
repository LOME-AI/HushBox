/**
 * The two published answers about a model's answer room, pinned by amount: the
 * room a prompt leaves the model, and whether a rung's reasoning budget plus a
 * minimum answer fits inside it.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { answerRoomTokens, effortFitsAnswerRoom, unpinnedEffortOf } from './answer-room.ts';
import { requiredCeilingTokens } from './turn-arithmetic.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';

const MODEL: PriceableModel = {
  modelId: modelId('vendor/model'),
  pricing: tokenPricingFixture({ input: nanoUSD(100n), output: nanoUSD(300n) }),
  contextLength: 100_000,
  providerCap: 8000,
  reasoning: {},
  releasedAtMs: 0,
};

describe('answerRoomTokens', () => {
  it('is the provider cap when the prompt leaves more context than the cap', () => {
    expect(answerRoomTokens(MODEL, 1000)).toBe(8000);
  });

  it('is the context headroom when the prompt leaves less than the cap', () => {
    expect(answerRoomTokens(MODEL, 95_000)).toBe(5000);
  });

  it('is the context headroom when the model declares no provider cap', () => {
    expect(answerRoomTokens({ ...MODEL, providerCap: undefined }, 1000)).toBe(99_000);
  });

  it('is zero when the prompt overruns the context window', () => {
    expect(answerRoomTokens(MODEL, 120_000)).toBe(0);
  });
});

describe('effortFitsAnswerRoom', () => {
  const floorAt = (effort: 'low' | 'off' | undefined): number =>
    requiredCeilingTokens(MODEL, effort);

  it('fits a rung whose room holds exactly its budget plus a minimum answer', () => {
    const room = { ...MODEL, providerCap: floorAt('low') };
    expect(effortFitsAnswerRoom(room, 'low', 0)).toBe(true);
  });

  it('refuses a rung whose room is one token short of its budget plus a minimum answer', () => {
    const room = { ...MODEL, providerCap: floorAt('low') - 1 };
    expect(effortFitsAnswerRoom(room, 'low', 0)).toBe(false);
  });

  it('holds the off rung to a minimum answer alone', () => {
    const room = { ...MODEL, providerCap: MINIMUM_OUTPUT_TOKENS };
    expect(effortFitsAnswerRoom(room, 'off', 0)).toBe(true);
    expect(
      effortFitsAnswerRoom({ ...room, providerCap: MINIMUM_OUTPUT_TOKENS - 1 }, 'off', 0)
    ).toBe(false);
  });

  it('holds a model with no rung to a minimum answer alone', () => {
    const plain = { ...MODEL, reasoning: undefined, providerCap: MINIMUM_OUTPUT_TOKENS - 1 };
    expect(effortFitsAnswerRoom(plain, undefined, 0)).toBe(false);
    expect(
      effortFitsAnswerRoom({ ...plain, providerCap: MINIMUM_OUTPUT_TOKENS }, undefined, 0)
    ).toBe(true);
  });

  it('measures the room the prompt leaves, not the provider cap alone', () => {
    const wide = { ...MODEL, providerCap: undefined, contextLength: 10_000 };
    expect(effortFitsAnswerRoom(wide, undefined, 10_000 - MINIMUM_OUTPUT_TOKENS)).toBe(true);
    expect(effortFitsAnswerRoom(wide, undefined, 10_000 - MINIMUM_OUTPUT_TOKENS + 1)).toBe(false);
  });
});

describe('unpinnedEffortOf', () => {
  it('is off for a model that can turn reasoning off', () => {
    expect(unpinnedEffortOf(MODEL)).toBe('off');
  });

  it('is the cheapest rung of a budget-native model that cannot turn reasoning off', () => {
    expect(unpinnedEffortOf({ ...MODEL, reasoning: { mandatory: true } })).toBe('lite');
  });

  it('is the only rung of a mandatory model that offers one', () => {
    const single = { ...MODEL, reasoning: { supportedEfforts: ['high'], mandatory: true } };
    expect(unpinnedEffortOf(single)).toBe('high');
  });

  it('is absent for a model that does not reason', () => {
    expect(unpinnedEffortOf({ ...MODEL, reasoning: undefined })).toBeUndefined();
  });
});
