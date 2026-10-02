/**
 * The Smart slot's `minTurnCost`, pinned by THE BICONDITIONAL it exists to
 * satisfy: funding equal to it makes a smart-slot turn sendable through the one
 * producer, funding one nano below it does not. Asking `getTurnOptions` is what
 * makes this an assertion about the ceiling solve as production composes it —
 * a second arrangement of the arithmetic here would stay green through any
 * change to the real one.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from './nano-usd.ts';
import { PREMIUM_RECENCY_MS } from './premium.ts';
import { smartSlotMinTurnCostNanoUsd } from './min-turn-cost.ts';
import { getTurnOptions } from '../turn/turn-options.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { PromptBasis, UserTier } from '../index.ts';

const PROMPT_CHARS = 400;

/** The new message inside {@link PROMPT_CHARS}; the rest is system prompt and history. */
const NEW_MESSAGE_CHARS = 100;

/** A window too small to hold {@link PROMPT_CHARS} and a minimum answer. */
const NARROW_CONTEXT_TOKENS = 500;

function modelFor(id: string, input: bigint, output: bigint, context = 100_000): PriceableModel {
  return {
    modelId: modelId(id),
    pricing: tokenPricingFixture({ input: nanoUSD(input), output: nanoUSD(output) }),
    contextLength: context,
    providerCap: 8000,
    releasedAtMs: 0,
    reasoning: undefined,
  };
}

const CHEAP = modelFor('vendor/cheap', 100n, 200n);
const DEARER = modelFor('vendor/dearer', 300n, 600n);
const THIRD = modelFor('vendor/third', 200n, 400n);

function basisOf(promptChars: number): PromptBasis {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: promptChars - NEW_MESSAGE_CHARS,
    inputChars: NEW_MESSAGE_CHARS,
    attachmentBytes: 0,
  };
}

interface SendOptions {
  readonly pinned?: readonly PriceableModel[];
  readonly webSearch?: boolean;
}

function sendableAt(
  pool: readonly PriceableModel[],
  tier: UserTier,
  fundingNanoUsd: bigint,
  { pinned = [], webSearch = false }: SendOptions = {}
): boolean {
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(fundingNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: tier,
      payer: 'self',
    },
    basisOf(PROMPT_CHARS),
    {
      answerSources: { models: pinned.map((model) => model.modelId), smartSlot: true },
      modality: 'text',
      pinned: {},
      webSearch,
    },
    { models: pool, nowMs: PREMIUM_RECENCY_MS }
  ).admissible.sendable;
}

function minimumFor(
  pool: readonly PriceableModel[],
  tier: UserTier,
  pinned: readonly PriceableModel[] = [],
  webSearch = false
): bigint | undefined {
  return smartSlotMinTurnCostNanoUsd({
    pool,
    pinned,
    promptChars: PROMPT_CHARS,
    inputChars: NEW_MESSAGE_CHARS,
    persists: tier !== 'trial',
    webSearch,
    reasoningEffort: 'auto',
  });
}

describe('smartSlotMinTurnCostNanoUsd', () => {
  it('is the exact funding boundary the one producer sends at', () => {
    const pool = [CHEAP, DEARER];
    const minimum = minimumFor(pool, 'paid')!;
    expect(sendableAt(pool, 'paid', minimum)).toBe(true);
    expect(sendableAt(pool, 'paid', minimum - 1n)).toBe(false);
  });

  it('holds the boundary for a one-model pool, where no classifier is bought', () => {
    const pool = [CHEAP];
    const minimum = minimumFor(pool, 'paid')!;
    expect(sendableAt(pool, 'paid', minimum)).toBe(true);
    expect(sendableAt(pool, 'paid', minimum - 1n)).toBe(false);
  });

  it('holds the boundary at the free tier', () => {
    const pool = [CHEAP, DEARER];
    const minimum = minimumFor(pool, 'free')!;
    expect(sendableAt(pool, 'free', minimum)).toBe(true);
    expect(sendableAt(pool, 'free', minimum - 1n)).toBe(false);
  });

  it('is set by the cheapest member the slot could resolve to, not by the pool', () => {
    // At the boundary exactly one arrangement runs, and it is the cheap one: a
    // bound taken over the whole pool would sit at the dearer model's corner and
    // refuse a payer who can in fact send.
    const pool = [CHEAP, DEARER];
    const minimum = minimumFor(pool, 'paid')!;
    const set = getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(minimum),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      basisOf(PROMPT_CHARS),
      {
        answerSources: { models: [], smartSlot: true },
        modality: 'text',
        pinned: {},
        webSearch: false,
      },
      { models: pool, nowMs: PREMIUM_RECENCY_MS }
    ).admissible;
    expect(set.sendable && set.runnable.map((entry) => entry.modelId)).toEqual([CHEAP.modelId]);
  });

  it('is the exact funding boundary for a slot sent beside a pinned sibling', () => {
    // The pinned model is also the cheapest, so this boundary is only right if
    // the slot cannot re-pick it: a bound priced on the doubled-cheap
    // arrangement sits BELOW what the producer sends at, and the same
    // re-pick would bill the payer for two answers from one model.
    const pool = [CHEAP, DEARER, THIRD];
    const minimum = minimumFor(pool, 'paid', [CHEAP])!;
    expect(sendableAt(pool, 'paid', minimum, { pinned: [CHEAP] })).toBe(true);
    expect(sendableAt(pool, 'paid', minimum - 1n, { pinned: [CHEAP] })).toBe(false);
  });

  it('is the exact funding boundary for a searching slot sent beside a pinned sibling', () => {
    const pool = [CHEAP, DEARER, THIRD];
    const minimum = minimumFor(pool, 'paid', [DEARER], true)!;
    expect(sendableAt(pool, 'paid', minimum, { pinned: [DEARER], webSearch: true })).toBe(true);
    expect(sendableAt(pool, 'paid', minimum - 1n, { pinned: [DEARER], webSearch: true })).toBe(
      false
    );
  });

  it('prices the tool loop on the pinned sibling, so searching raises a mixed turn’s figure', () => {
    const pool = [CHEAP, DEARER, THIRD];
    expect(minimumFor(pool, 'paid', [DEARER], true)!).toBeGreaterThan(
      minimumFor(pool, 'paid', [DEARER])!
    );
  });

  it('prices no tool loop on the slot’s own answer, so searching leaves a slot-only figure alone', () => {
    const pool = [CHEAP, DEARER];
    expect(minimumFor(pool, 'paid', [], true)).toBe(minimumFor(pool, 'paid'));
  });

  it('prices the pinned sibling too, so a mixed turn costs more than the slot alone', () => {
    const pool = [CHEAP, DEARER, THIRD];
    expect(minimumFor(pool, 'paid', [DEARER])!).toBeGreaterThan(minimumFor(pool, 'paid')!);
  });

  it('has no figure when the pinned siblings leave the slot nothing to resolve to', () => {
    expect(minimumFor([CHEAP], 'paid', [CHEAP])).toBeUndefined();
  });

  it('has no figure when nothing in the pool prices a turn', () => {
    expect(minimumFor([], 'paid')).toBeUndefined();
  });

  it('has no figure when every candidate prices but no window holds a minimum answer', () => {
    // The second of the two textually distinct causes of `undefined`, and the
    // one line coverage cannot see: the pool prices — these carry the same rates
    // the priced boundaries above are taken on — yet every window is too narrow
    // to hold the prompt AND a minimum answer, so no arrangement is priceable.
    // Both causes leave through the same statement, so only a fixture tells them
    // apart.
    const narrowCheap = modelFor('vendor/narrow-cheap', 100n, 200n, NARROW_CONTEXT_TOKENS);
    const narrowDearer = modelFor('vendor/narrow-dearer', 300n, 600n, NARROW_CONTEXT_TOKENS);
    expect(minimumFor([narrowCheap, narrowDearer], 'paid')).toBeUndefined();
  });

  it('finds the figure again as soon as one member’s window holds a minimum answer', () => {
    const narrowCheap = modelFor('vendor/narrow-cheap', 100n, 200n, NARROW_CONTEXT_TOKENS);
    expect(minimumFor([narrowCheap, DEARER], 'paid')).toBeGreaterThan(0n);
  });

  it('skips a member no funding can make runnable, however cheap it is', () => {
    // A window too small to hold the prompt AND a minimum answer is a capability
    // refusal, not a money one, so no balance clears it. Pricing the bound on it
    // puts the threshold below what the producer actually sends at — the payer
    // freeze then admits a turn that is refused however much is in the wallet.
    const tooNarrow = modelFor('vendor/aaa-narrow', 1n, 1n, 500);
    const pool = [tooNarrow, CHEAP, DEARER];
    const minimum = minimumFor(pool, 'paid')!;
    expect(sendableAt(pool, 'paid', minimum)).toBe(true);
    expect(sendableAt(pool, 'paid', minimum - 1n)).toBe(false);
  });
});
