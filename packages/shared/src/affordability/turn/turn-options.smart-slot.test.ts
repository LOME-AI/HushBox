/**
 * The smart slot's own verdict, read off a produced set.
 *
 * Every set here comes from the real producer rather than a hand-shaped literal:
 * the fact under test is that the produced set ALREADY answers "can the slot
 * resolve to anything", and a literal would assert the shape of an answer this
 * file made up.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from '../model/model-id.ts';
import { nanoUSD } from '../money/nano-usd.ts';
import { getTurnOptions, smartSlotAvailability } from './turn-options.ts';
import { EMPTY_PROMPT_BASIS, refusalPrecedence } from './turn-types.ts';
import { TEST_DAY_START } from '../../testing/test-time.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';
import type { ModelId } from '../model/model-id.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { FundingSnapshot, RefusalCode, Selection } from './turn-types.ts';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = TEST_DAY_START;

const A: PriceableModel = {
  modelId: modelId('vendor/a'),
  pricing: tokenPricingFixture({ input: nanoUSD(1000n), output: nanoUSD(2000n) }),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};
const B: PriceableModel = { ...A, modelId: modelId('vendor/b') };
const C: PriceableModel = { ...A, modelId: modelId('vendor/c') };
const CATALOG = [A, B, C];

/**
 * A split-price catalog: the pinned model runs on funding that leaves both
 * candidates blocked, which is the only way to reach a SENDABLE set whose pool
 * is empty for a reason other than everything being pinned.
 */
const CHEAP: PriceableModel = { ...A, modelId: modelId('vendor/cheap') };
const DEAR: PriceableModel = {
  ...A,
  modelId: modelId('vendor/dear'),
  pricing: tokenPricingFixture({ input: nanoUSD(100_000n), output: nanoUSD(200_000n) }),
};
const DEARER: PriceableModel = { ...DEAR, modelId: modelId('vendor/dearer') };
const SPLIT_CATALOG = [CHEAP, DEAR, DEARER];

/**
 * The costliest and most recently released model, so a free-tier payer is
 * blocked on TIER while the merely dear one is blocked on MONEY. It sorts last
 * into the pool, which is what makes pool order and refusal precedence disagree.
 */
const PREMIUM: PriceableModel = {
  ...A,
  modelId: modelId('vendor/premium'),
  releasedAtMs: NOW_MS - 1000,
  pricing: tokenPricingFixture({ input: nanoUSD(120_000n), output: nanoUSD(240_000n) }),
};
const MIXED_CATALOG = [CHEAP, DEAR, PREMIUM];

/**
 * Two candidates released inside the premium recency window, beside a pinned
 * model that predates it. Every member of the pool is tier-locked and nothing
 * else about them blocks, which is the case that keeps the tier reason's own
 * justification true: no balance unlocks any of them.
 */
const RECENT: PriceableModel = {
  ...A,
  modelId: modelId('vendor/recent'),
  releasedAtMs: NOW_MS - 1000,
};
const RECENT_TWIN: PriceableModel = { ...RECENT, modelId: modelId('vendor/recent-twin') };
const TIER_LOCKED_CATALOG = [CHEAP, RECENT, RECENT_TWIN];

/** Inside the band: the cheap model's arrangement runs, neither dear one does. */
const FUNDING_BOUND = 10_000_000n;

/** Enough to fund any arrangement of this catalog many times over. */
const RICH = 10_000_000_000n;

function fundingOf(
  spendableNanoUsd: bigint,
  payerTier: FundingSnapshot['payerTier'] = 'paid'
): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(spendableNanoUsd),
    heldNanoUsd: nanoUSD(0n),
    payerTier,
    payer: 'self',
  };
}

function selectionOf(pinned: readonly string[], smartSlot: boolean): Selection {
  return {
    answerSources: {
      models: pinned.map((id): ModelId => modelId(id)),
      smartSlot,
    } as Selection['answerSources'],
    modality: 'text',
    pinned: {},
    webSearch: false,
  };
}

function affordableSetFor(
  spendableNanoUsd: bigint,
  pinned: readonly string[],
  smartSlot: boolean,
  over: {
    readonly catalog?: readonly PriceableModel[];
    readonly payerTier?: FundingSnapshot['payerTier'];
  } = {}
): ReturnType<typeof getTurnOptions>['affordable'] {
  return getTurnOptions(
    fundingOf(spendableNanoUsd, over.payerTier ?? 'paid'),
    EMPTY_PROMPT_BASIS,
    selectionOf(pinned, smartSlot),
    { models: over.catalog ?? CATALOG, nowMs: NOW_MS }
  ).affordable;
}

/** The reasons the set's own candidate rows were blocked for. */
function blockedCandidateReasons(
  set: ReturnType<typeof getTurnOptions>['affordable']
): readonly RefusalCode[] {
  return set.all.flatMap((entry) =>
    entry.kind === 'candidate' && !entry.availability.available ? [entry.availability.reason] : []
  );
}

describe('the slot verdict on the produced pair', () => {
  /** The producer's own answer, taken over the same inputs the set was. */
  function producedFor(
    spendableNanoUsd: bigint,
    pinned: readonly string[],
    smartSlot: boolean
  ): ReturnType<typeof getTurnOptions> {
    return getTurnOptions(
      fundingOf(spendableNanoUsd, 'paid'),
      EMPTY_PROMPT_BASIS,
      selectionOf(pinned, smartSlot),
      { models: CATALOG, nowMs: NOW_MS }
    );
  }

  it('rides on the produced pair, so no caller composes it from the set', () => {
    expect(producedFor(RICH, ['vendor/a'], false).smartSlot).toEqual({ available: true });
  });

  it('carries the refusal when every affordable model is already pinned', () => {
    const produced = producedFor(RICH, ['vendor/a', 'vendor/b', 'vendor/c'], false);

    expect(produced.affordable.sendable).toBe(true);
    expect(produced.smartSlot.available).toBe(false);
  });

  /**
   * A payer whose spendable is entirely consumed by a hold already out. It is
   * the ONE arrangement in which the two sets answer the slot differently:
   * `affordable` sees `spendable + held` and offers it, `admissible` sees
   * `spendable` alone and cannot start a turn at all.
   *
   * Every other fixture in this file leaves them identical — zero held, empty
   * basis — which is why an assertion naming only `affordable` is satisfied by
   * a producer reading `admissible` and proves nothing about which set was read.
   */
  function producedWithHoldOut(): ReturnType<typeof getTurnOptions> {
    return getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(0n),
        heldNanoUsd: nanoUSD(RICH),
        payerTier: 'paid',
        payer: 'self',
      },
      EMPTY_PROMPT_BASIS,
      selectionOf([], true),
      { models: CATALOG, nowMs: NOW_MS }
    );
  }

  it('keeps the two sets apart in this fixture, or the assertions below prove nothing', () => {
    const produced = producedWithHoldOut();

    // The precondition, asserted rather than assumed: if a future edit collapses
    // the divergence, this fails loudly instead of quietly re-vacuuming the guard.
    expect(produced.affordable.sendable).toBe(true);
    expect(produced.admissible.sendable).toBe(false);
    expect(smartSlotAvailability(produced.affordable)).not.toEqual(
      smartSlotAvailability(produced.admissible)
    );
  });

  it('offers the slot while a hold is out, because greying reads `affordable`', () => {
    const produced = producedWithHoldOut();

    // The user-visible fact: the slot stays offered when the only thing that
    // moved is a hold. Grading it against the send gate greys it while no row
    // beside it moved.
    expect(produced.smartSlot).toEqual(smartSlotAvailability(produced.affordable));
    expect(produced.smartSlot.available).toBe(true);
  });

  it('is NOT the send gate’s answer — the half that makes the line above a guard', () => {
    const produced = producedWithHoldOut();

    expect(produced.smartSlot).not.toEqual(smartSlotAvailability(produced.admissible));
    expect(smartSlotAvailability(produced.admissible).available).toBe(false);
  });
});

describe('smartSlotAvailability', () => {
  it('offers the slot while some candidate row can still answer', () => {
    const set = affordableSetFor(RICH, ['vendor/a'], false);

    expect(smartSlotAvailability(set)).toEqual({ available: true });
  });

  it('refuses the slot when every affordable model is already pinned', () => {
    const set = affordableSetFor(RICH, ['vendor/a', 'vendor/b', 'vendor/c'], false);

    // The turn itself still sends — the pinned siblings answer it — so the
    // refusal is the slot's alone rather than the turn's.
    expect(set.sendable).toBe(true);
    expect(smartSlotAvailability(set)).toEqual({
      available: false,
      reason: 'model_not_priceable',
    });
  });

  it('gives the same refusal the producer gives a slot turn with nothing to resolve to', () => {
    const withoutSlot = affordableSetFor(RICH, ['vendor/a', 'vendor/b', 'vendor/c'], false);
    const withSlot = affordableSetFor(RICH, ['vendor/a', 'vendor/b', 'vendor/c'], true);

    expect(withSlot.sendable).toBe(false);
    expect(smartSlotAvailability(withoutSlot)).toEqual({
      available: false,
      reason: withSlot.sendable ? undefined : withSlot.refusal,
    });
  });

  it('gives the reason its own blocked candidate rows carry when the pool is funding-bound', () => {
    const set = affordableSetFor(FUNDING_BOUND, ['vendor/cheap'], false, {
      catalog: SPLIT_CATALOG,
    });

    // The turn sends on its pinned model while both candidates are priced out,
    // so the slot's emptiness has a reason and the rows beside it carry it.
    expect(set.sendable).toBe(true);
    expect(blockedCandidateReasons(set)).toEqual(['insufficient_funds', 'insufficient_funds']);
    expect(smartSlotAvailability(set)).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('yields a mixed pool`s tier lock to the money reason its payer can act on', () => {
    const set = affordableSetFor(FUNDING_BOUND, ['vendor/cheap'], false, {
      catalog: MIXED_CATALOG,
      payerTier: 'free',
    });

    expect(blockedCandidateReasons(set)).toEqual(['insufficient_funds', 'premium_requires_credit']);
    // What makes this discriminating: over these same two reasons the
    // single-model order answers the tier one, so a slot reading it would tell a
    // free-tier payer to buy premium access the pool would still not pick from.
    expect(refusalPrecedence(blockedCandidateReasons(set))).toBe('premium_requires_credit');
    expect(smartSlotAvailability(set)).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('still reports the tier lock when ample funding leaves the whole pool premium', () => {
    const set = affordableSetFor(RICH, ['vendor/cheap'], false, {
      catalog: TIER_LOCKED_CATALOG,
      payerTier: 'free',
    });

    expect(set.sendable).toBe(true);
    expect(blockedCandidateReasons(set)).toEqual([
      'premium_requires_credit',
      'premium_requires_credit',
    ]);
    expect(smartSlotAvailability(set)).toEqual({
      available: false,
      reason: 'premium_requires_credit',
    });
  });

  it('gives the same refusal the producer gives a funding-bound slot turn', () => {
    const withoutSlot = affordableSetFor(FUNDING_BOUND, ['vendor/cheap'], false, {
      catalog: SPLIT_CATALOG,
    });
    const withSlot = affordableSetFor(FUNDING_BOUND, ['vendor/cheap'], true, {
      catalog: SPLIT_CATALOG,
    });

    expect(withSlot.sendable).toBe(false);
    expect(smartSlotAvailability(withoutSlot)).toEqual({
      available: false,
      reason: withSlot.sendable ? undefined : withSlot.refusal,
    });
  });

  it('gives the same refusal the producer gives a mixed slot turn', () => {
    const withoutSlot = affordableSetFor(FUNDING_BOUND, ['vendor/cheap'], false, {
      catalog: MIXED_CATALOG,
      payerTier: 'free',
    });
    const withSlot = affordableSetFor(FUNDING_BOUND, ['vendor/cheap'], true, {
      catalog: MIXED_CATALOG,
      payerTier: 'free',
    });

    // The two collapse points reduce the same pool, so a payer sees one sentence
    // whether the slot is offered beside a pinned model or is the turn itself.
    expect(withSlot).toMatchObject({ sendable: false, refusal: 'insufficient_funds' });
    expect(smartSlotAvailability(withoutSlot)).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('refuses a mixed slot turn on the money reason, in the arm the send gate reads', () => {
    const produced = getTurnOptions(
      fundingOf(FUNDING_BOUND, 'free'),
      EMPTY_PROMPT_BASIS,
      selectionOf(['vendor/cheap'], true),
      { models: MIXED_CATALOG, nowMs: NOW_MS }
    );

    // `admissible` is the arm the send gate refuses from and the client re-voices
    // on. A tier code reaching it is one the re-voicing has no branch for, so the
    // held-funds and length wordings never render for a pool.
    expect(produced.admissible).toMatchObject({
      sendable: false,
      refusal: 'insufficient_funds',
    });
  });

  it('carries the turn-level refusal when the set cannot send at all', () => {
    const set = affordableSetFor(1n, ['vendor/a'], false);

    expect(set.sendable).toBe(false);
    expect(smartSlotAvailability(set)).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });
});
