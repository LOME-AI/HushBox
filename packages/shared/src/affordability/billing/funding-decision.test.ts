import { describe, expect, it } from 'vitest';
import { PAID_CUSHION_NANO_USD } from '../estimate/pre-adapters.ts';
import {
  bindingGroupLimit,
  holdAwareGroupHeadroom,
  resolveFunding,
  type FundingInputs,
  type HoldAwareGroupDimensions,
} from './funding-decision.ts';

/** A four-cent `minTurnCost`, the amount the group headroom has to cover. */
const MIN_TURN_COST = 40_000_000n;

/**
 * Base inputs for a solo owner with a positive purchased balance selecting a
 * non-premium model, with no turn priced. Individual cases override only the
 * fields under test.
 */
function inputs(overrides: Partial<FundingInputs>): FundingInputs {
  return {
    isSolo: true,
    isGuest: false,
    memberRemainingNanoUsd: 0n,
    conversationRemainingNanoUsd: 0n,
    ownerPurchasedBalanceNanoUsd: 0n,
    callerOwnPurchasedBalanceNanoUsd: 1000n,
    isPremiumModel: false,
    minTurnCostNanoUsd: undefined,
    ...overrides,
  };
}

/** Group inputs whose three headroom dimensions are all `headroom`. */
function groupInputs(headroom: bigint, overrides: Partial<FundingInputs>): FundingInputs {
  return inputs({
    isSolo: false,
    memberRemainingNanoUsd: headroom,
    conversationRemainingNanoUsd: headroom,
    ownerPurchasedBalanceNanoUsd: headroom,
    callerOwnPurchasedBalanceNanoUsd: 0n,
    ...overrides,
  });
}

describe('resolveFunding', () => {
  it('funds a solo owner with a positive purchased balance from their purchased wallet', () => {
    expect(resolveFunding(inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 5n }))).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('funds a solo owner with no purchased balance from their free wallet', () => {
    expect(resolveFunding(inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 0n }))).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
    });
  });

  it('locks a premium model for a self-funding caller with no purchased balance', () => {
    expect(
      resolveFunding(
        inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 0n, isPremiumModel: true })
      )
    ).toEqual({ payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' });
  });

  it('allows a premium model for a self-funding caller with a positive purchased balance', () => {
    expect(
      resolveFunding(
        inputs({ isSolo: true, callerOwnPurchasedBalanceNanoUsd: 5n, isPremiumModel: true })
      )
    ).toEqual({ payer: 'self', walletKind: 'purchased', premiumAllowed: true });
  });

  it('owner-funds a member turn when group headroom is positive', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 100n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 100n,
    });
  });

  it('owner-funds a member turn on a premium model without a tier lock (owner-funded exemption)', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 100n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
          isPremiumModel: true,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 100n,
    });
  });

  it('owner-funds when the conversation dimension is the tightest positive headroom', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 1000n,
          conversationRemainingNanoUsd: 5n,
          ownerPurchasedBalanceNanoUsd: 1000n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 5n,
    });
  });

  it("owner-funds when the owner's spendable funds are the tightest positive headroom", () => {
    // Both caps sit above the owner's balance AND its cushion, so the owner
    // dimension binds and the headroom is what that wallet can actually spend.
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 900_000_000_000n,
          conversationRemainingNanoUsd: 900_000_000_000n,
          ownerPurchasedBalanceNanoUsd: 5n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 5n + PAID_CUSHION_NANO_USD,
    });
  });

  it("owner-funds on the owner's cushion when the raw balance alone falls short of the minimum", () => {
    // Both caps are generous, so the owner's own funds bind. A $0.01 balance
    // cannot cover a $0.04 turn, but a paid wallet may overdraw by its cushion —
    // and the cushion belongs to the wallet, so it is available whether the
    // owner is answering their own turn or a member's.
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 1_000_000_000n,
          conversationRemainingNanoUsd: 1_000_000_000n,
          ownerPurchasedBalanceNanoUsd: 10_000_000n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
          minTurnCostNanoUsd: MIN_TURN_COST,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 10_000_000n + PAID_CUSHION_NANO_USD,
    });
  });

  it("never lifts the headroom above the sending member's own allocation", () => {
    // The property the cushion-inside-the-min buys: a 1¢ member allocation
    // funds 1¢ of turn, however solvent the owner is. Were the cushion added to
    // the min instead, this would answer $0.51 and every send would be frozen
    // owner-funded and then refused by the member scope at admission.
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 10_000_000n,
          conversationRemainingNanoUsd: 1_000_000_000n,
          ownerPurchasedBalanceNanoUsd: 1_000_000_000n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
          minTurnCostNanoUsd: 1n,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 10_000_000n,
    });
  });

  it('withholds the cushion from an owner whose balance is spent to zero', () => {
    // The cushion is a property of a wallet that still has funds, so it cannot
    // conjure headroom out of an empty one.
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 1_000_000_000n,
          conversationRemainingNanoUsd: 1_000_000_000n,
          ownerPurchasedBalanceNanoUsd: 0n,
          callerOwnPurchasedBalanceNanoUsd: 7n,
          minTurnCostNanoUsd: 1n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('clamps each headroom dimension to zero before the min so an overspent member blocks owner funding', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: -50n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 7n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('treats an absent member-budget row (0 headroom) as fall-through to self funding', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          memberRemainingNanoUsd: 0n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('refuses a link guest when group headroom is exhausted (no wallet to fall through to)', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          isGuest: true,
          memberRemainingNanoUsd: 0n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({ payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('owner-funds a link guest when group headroom is positive', () => {
    expect(
      resolveFunding(
        inputs({
          isSolo: false,
          isGuest: true,
          memberRemainingNanoUsd: 100n,
          conversationRemainingNanoUsd: 100n,
          ownerPurchasedBalanceNanoUsd: 100n,
          callerOwnPurchasedBalanceNanoUsd: 0n,
        })
      )
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 100n,
    });
  });
});

describe('resolveFunding — priority 1 compares `minTurnCost`', () => {
  it('owner-funds when the headroom exactly equals the minimum turn cost', () => {
    expect(
      resolveFunding(groupInputs(MIN_TURN_COST, { minTurnCostNanoUsd: MIN_TURN_COST }))
    ).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: MIN_TURN_COST,
    });
  });

  it('falls through to self funding when the headroom is one nano below the minimum turn cost', () => {
    expect(
      resolveFunding(
        groupInputs(MIN_TURN_COST - 1n, {
          minTurnCostNanoUsd: MIN_TURN_COST,
          callerOwnPurchasedBalanceNanoUsd: 7n,
        })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('refuses a link guest whose headroom is positive but below the minimum turn cost', () => {
    expect(
      resolveFunding(
        groupInputs(MIN_TURN_COST - 1n, { isGuest: true, minTurnCostNanoUsd: MIN_TURN_COST })
      )
    ).toEqual({ payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' });
  });

  it('owner-funds on positive headroom when no turn is priced', () => {
    // The unpriced query — who WOULD pay — has no comparison to apply.
    expect(resolveFunding(groupInputs(1n, { minTurnCostNanoUsd: undefined }))).toEqual({
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: 1n,
    });
  });

  it('never owner-funds exhausted headroom, even against a zero minimum', () => {
    expect(
      resolveFunding(
        groupInputs(0n, { minTurnCostNanoUsd: 0n, callerOwnPurchasedBalanceNanoUsd: 7n })
      )
    ).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('marks no payer switch on a solo turn', () => {
    // `toStrictEqual` so the key is asserted present and undefined: a consumer
    // reading it sees "no disclosure", not a missing field.
    expect(
      resolveFunding(inputs({ isSolo: true, minTurnCostNanoUsd: MIN_TURN_COST }))
    ).toStrictEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: undefined,
    });
  });
});

describe('holdAwareGroupHeadroom', () => {
  /** All five dimensions generous, so a case's overrides are what binds. */
  function dimensions(
    overrides: Partial<Parameters<typeof holdAwareGroupHeadroom>[0]>
  ): Parameters<typeof holdAwareGroupHeadroom>[0] {
    return {
      memberRemainingNanoUsd: 1_000_000_000n,
      memberHeldNanoUsd: 0n,
      conversationRemainingNanoUsd: 1_000_000_000n,
      conversationHeldNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 1_000_000_000n,
      ...overrides,
    };
  }

  it("takes each scope's hold off its OWN dimension before the min", () => {
    // The member hold must not shrink the conversation dimension and vice
    // versa: subtracting either from the min instead would let one scope's
    // in-flight run eat the other's allocation.
    expect(
      holdAwareGroupHeadroom(
        dimensions({
          memberRemainingNanoUsd: 100n,
          memberHeldNanoUsd: 10n,
          conversationRemainingNanoUsd: 95n,
          conversationHeldNanoUsd: 0n,
        })
      )
    ).toBe(90n);
  });

  it('clamps an over-held dimension to zero rather than letting it go negative', () => {
    expect(
      holdAwareGroupHeadroom(dimensions({ memberRemainingNanoUsd: 10n, memberHeldNanoUsd: 40n }))
    ).toBe(0n);
  });

  it("carries the owner's cushion, and no hold comes off the owner dimension", () => {
    // The owner dimension enters raw so the cushion is applied exactly once,
    // downstream; the owner wallet's own holds are not this readout's scope, so
    // nothing here may subtract from it.
    expect(
      holdAwareGroupHeadroom(
        dimensions({ ownerPurchasedBalanceNanoUsd: 5n, memberHeldNanoUsd: 0n })
      )
    ).toBe(5n + PAID_CUSHION_NANO_USD);
  });

  it('returns the smallest hold-subtracted dimension when the conversation binds', () => {
    expect(
      holdAwareGroupHeadroom(
        dimensions({
          memberRemainingNanoUsd: 500n,
          memberHeldNanoUsd: 30n,
          conversationRemainingNanoUsd: 700n,
          conversationHeldNanoUsd: 200n,
        })
      )
    ).toBe(470n);
  });
});

describe('bindingGroupLimit', () => {
  /** No hold in flight, so a case names only the remaining figures it binds on. */
  function unheld(
    memberRemainingNanoUsd: bigint,
    conversationRemainingNanoUsd: bigint,
    ownerPurchasedBalanceNanoUsd: bigint
  ): HoldAwareGroupDimensions {
    return {
      memberRemainingNanoUsd,
      memberHeldNanoUsd: 0n,
      conversationRemainingNanoUsd,
      conversationHeldNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd,
    };
  }

  it('names the conversation budget when it is the smallest dimension', () => {
    expect(bindingGroupLimit(unheld(5n, 0n, 10n))).toBe('conversation_budget');
  });

  it('names the member allocation when it ties the conversation budget', () => {
    expect(bindingGroupLimit(unheld(0n, 0n, 10n))).toBe('member_allocation');
  });

  it("names the owner's balance when the owner's balance is negative", () => {
    expect(bindingGroupLimit(unheld(1000n, 1000n, -1n))).toBe('owner_balance');
  });

  it("names the owner's balance when every dimension is zero", () => {
    expect(bindingGroupLimit(unheld(0n, 0n, -1n))).toBe('owner_balance');
  });

  it('names the member allocation when a member-scope hold brings it below the conversation remaining', () => {
    expect(
      bindingGroupLimit({
        memberRemainingNanoUsd: 100n,
        memberHeldNanoUsd: 30n,
        conversationRemainingNanoUsd: 80n,
        conversationHeldNanoUsd: 0n,
        ownerPurchasedBalanceNanoUsd: 1000n,
      })
    ).toBe('member_allocation');
  });
});

describe('resolveFunding — a $0.00 overall budget funds nothing', () => {
  const FIVE_DOLLARS = 5_000_000_000n;
  const TEN_DOLLARS = 10_000_000_000n;

  /** A member's $5.00 allowance and a $10.00 owner, under a $0.00 conversation budget. */
  function zeroBudgetInputs(overrides: Partial<FundingInputs>): FundingInputs {
    return inputs({
      isSolo: false,
      memberRemainingNanoUsd: FIVE_DOLLARS,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: TEN_DOLLARS,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      ...overrides,
    });
  }

  it('falls a signed-in member through to self funding with the payer-switch reason', () => {
    expect(resolveFunding(zeroBudgetInputs({ isGuest: false }))).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: 'group_headroom_insufficient',
    });
  });

  it('refuses a link guest as group budget exhausted', () => {
    expect(resolveFunding(zeroBudgetInputs({ isGuest: true }))).toEqual({
      payer: 'refuse',
      refusalCode: 'GROUP_BUDGET_EXHAUSTED',
    });
  });
});
