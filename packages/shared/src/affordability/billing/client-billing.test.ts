import { describe, expect, it } from 'vitest';
import {
  resolveClientBilling,
  deriveClientFundingInputs,
  type ClientBillingInput,
  type ClientFundingContext,
  type ResolveBillingResult,
} from './client-billing.ts';
import { resolveFunding } from './funding-decision.ts';

const NANO_PER_CENT = 10_000_000n;

function input(overrides: Partial<ClientBillingInput>): ClientBillingInput {
  return {
    tier: 'paid',
    purchasedBalanceNanoUsd: 1000n * NANO_PER_CENT,
    // Served spendable: balance + cushion − holds; defaults to balance + 50¢.
    spendableNanoUsd: 1050n * NANO_PER_CENT,
    isPremiumModel: false,
    estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
    ...overrides,
  };
}

describe('resolveClientBilling — self-funding vocabulary', () => {
  it('paid tier with served spendable covering the estimate → personal_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'paid', spendableNanoUsd: 1050n * NANO_PER_CENT }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('paid tier with served spendable below the estimate → insufficient_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: 1n * NANO_PER_CENT,
          spendableNanoUsd: 51n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 100_000n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('paid tier spendable exactly equal to the estimate → personal_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 40n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 40n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });

  it('paid tier never re-adds the cushion on top of the served spendable', () => {
    // The served number already bakes the $0.50 cushion (and hold subtraction).
    // spendable 10¢, estimate 30¢: a double-cushion bug would pass (10 + 50 ≥ 30);
    // the correct compare denies.
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 10n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 30n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'insufficient_balance' });
  });

  it('free tier with allowance covering the estimate → free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 100n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
  });

  it('free tier compares exact bigint — allowance one nano short denies', () => {
    // The deleted 1e-6-cent float tolerance must not survive: a shortfall of a
    // single nano-USD is a real shortfall in exact integer money.
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 10n * NANO_PER_CENT - 1n,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'insufficient_free_allowance',
    });
  });

  it('free tier with allowance exactly equal to the estimate → free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 10n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
  });

  it('free tier with depleted allowance → insufficient_free_allowance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'insufficient_free_allowance',
    });
  });

  it('free tier whose allowance is reserved by a run in flight → insufficient_free_allowance', () => {
    // The served figure is hold-aware: 50¢ of allowance with 40¢ reserved by
    // this payer's own run leaves 10¢, which cannot cover a 20¢ turn. A
    // hold-blind reading offers a send admission then refuses — the free-tier
    // half of the one-verdict rule, and the reason this arm reads the served
    // number rather than a separately fetched allowance.
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 10n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 20n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'insufficient_free_allowance',
    });
  });

  it('trial tier within the fixed 1¢ cap → trial_fixed', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'trial',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'trial_fixed' });
  });

  it('trial tier over the fixed cap → trial_limit_exceeded', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'trial',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT + 1n,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'trial_limit_exceeded' });
  });

  it('guest whose served payer figure cannot cover the estimate → guest_budget_exhausted', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'guest_budget_exhausted' });
  });

  it('guest whose served payer figure covers the estimate → owner_balance, never denied', () => {
    // The denial must arrive from a funding COMPARISON, never from the tier: a
    // guest is owner-funded (§Group Funding 1), so a funded one sends.
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 90n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });

  it('guest selecting a premium model on a funded link is not tier-locked', () => {
    // Premium access is the PAYER's (§User Tiers), and the payer's tier is not
    // the guest's own — a guest holds no wallet to be graded on.
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 90n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
          isPremiumModel: true,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });

  it('guest never takes the trial per-message ceiling', () => {
    // The trial ceiling exists because a trial session has NO funding endpoint
    // to read. A guest has one, so an estimate above the 1¢ trial cap is judged
    // against the served payer figure alone.
    expect(
      resolveClientBilling(
        input({
          tier: 'guest',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 90n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 50n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'owner_balance' });
  });
});

describe('resolveClientBilling — premium gating via the shared core', () => {
  it('free tier selecting a premium model → premium_requires_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          isPremiumModel: true,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'premium_requires_balance',
    });
  });

  it('trial tier selecting a premium model → premium_requires_balance', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'trial',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 0n,
          isPremiumModel: true,
          estimatedMinimumCostNanoUsd: 1n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'premium_requires_balance',
    });
  });

  it('paid tier selecting a premium model it can afford → personal_balance', () => {
    expect(
      resolveClientBilling(input({ tier: 'paid', isPremiumModel: true }))
    ).toEqual<ResolveBillingResult>({ fundingSource: 'personal_balance' });
  });
});

describe('resolveClientBilling — negative-balance guard', () => {
  it('names a negative balance when the purchased wallet is below zero', () => {
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: -2_500_000_000n,
          spendableNanoUsd: 0n,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'negative_balance' });
  });

  it('names no negative balance when the purchased wallet is exactly zero', () => {
    const result = resolveClientBilling(
      input({
        tier: 'free',
        purchasedBalanceNanoUsd: 0n,
        spendableNanoUsd: 0n,
        estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
      })
    );
    expect(result).not.toEqual<ResolveBillingResult>({
      fundingSource: 'denied',
      reason: 'negative_balance',
    });
  });

  it('solo caller with an overdrawn purchased wallet → negative_balance', () => {
    // getUserTier maps a negative balance to the free tier; the guard fires first.
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: -100n * NANO_PER_CENT,
          spendableNanoUsd: 0n,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'negative_balance' });
  });

  it('overdrawn wallet denies even when the served spendable is positive', () => {
    // Complementary defense (never collapse into the spendable compare): a
    // −$0.10 balance still yields a +40¢ cushioned spendable, but new paid
    // turns are hard-blocked until top-up.
    expect(
      resolveClientBilling(
        input({
          tier: 'paid',
          purchasedBalanceNanoUsd: -10n * NANO_PER_CENT,
          spendableNanoUsd: 40n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 5n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'denied', reason: 'negative_balance' });
  });
});

describe('deriveClientFundingInputs — routes through the shared core', () => {
  it('a solo positive-balance caller resolves to self/purchased with premium allowed', () => {
    const fundingInputs = deriveClientFundingInputs(input({ tier: 'paid' }));
    expect(fundingInputs.isSolo).toBe(true);
    expect(resolveFunding(fundingInputs)).toEqual({
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
    });
  });

  it('a signed-in caller always resolves the SOLO arm — the served payer names the payer', () => {
    // The client holds no channel for group dimensions, so it cannot reassemble
    // an owner-funded verdict: the wire serves the payer and its figures. The
    // cast supplies the shape a caller might try to smuggle in and asserts it
    // changes nothing, which a missing field alone could not demonstrate.
    const smuggled = {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 50n * NANO_PER_CENT,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
      group: {
        effectiveRemainingNanoUsd: 500n * NANO_PER_CENT,
        ownerBalanceNanoUsd: 5000n * NANO_PER_CENT,
      },
    } as ClientFundingContext;

    const fundingInputs = deriveClientFundingInputs(smuggled);

    expect(fundingInputs.isSolo).toBe(true);
    expect(resolveFunding(fundingInputs)).toEqual({
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: undefined,
    });
    // And the shell it feeds carries no disclosure of its own: a switch is not
    // a fact this layer can know.
    expect(
      resolveClientBilling(
        input({
          tier: 'free',
          purchasedBalanceNanoUsd: 0n,
          spendableNanoUsd: 50n * NANO_PER_CENT,
          estimatedMinimumCostNanoUsd: 10n * NANO_PER_CENT,
        })
      )
    ).toEqual<ResolveBillingResult>({ fundingSource: 'free_allowance' });
  });

  it("carries a link guest's served figure into the core as the group headroom", () => {
    // No second field composes it: the guest's funding read serves the clamped
    // owner-funded minimum, so the three group dimensions ARE that number, and
    // an empty allowance refuses through the core rather than through the tier.
    const fundingInputs = deriveClientFundingInputs(
      input({ tier: 'guest', purchasedBalanceNanoUsd: 0n, spendableNanoUsd: 0n })
    );
    expect(fundingInputs.isGuest).toBe(true);
    expect(fundingInputs.isSolo).toBe(false);
    expect(fundingInputs.callerOwnPurchasedBalanceNanoUsd).toBe(0n);
    expect(resolveFunding(fundingInputs)).toEqual({
      payer: 'refuse',
      refusalCode: 'GROUP_BUDGET_EXHAUSTED',
    });
  });

  it("maps a funded guest's served figure onto every group dimension", () => {
    const fundingInputs = deriveClientFundingInputs(
      input({ tier: 'guest', purchasedBalanceNanoUsd: 0n, spendableNanoUsd: 90n * NANO_PER_CENT })
    );
    expect(fundingInputs.memberRemainingNanoUsd).toBe(90n * NANO_PER_CENT);
    expect(fundingInputs.conversationRemainingNanoUsd).toBe(90n * NANO_PER_CENT);
    expect(fundingInputs.ownerPurchasedBalanceNanoUsd).toBe(90n * NANO_PER_CENT);
  });

  it("feeds the surface's minimum cost to the core as the turn's minimum", () => {
    // Priority 1's comparison is only makeable if the client's shell hands the
    // amount it already knows to the core.
    const fundingInputs = deriveClientFundingInputs(
      input({ estimatedMinimumCostNanoUsd: 33n * NANO_PER_CENT })
    );
    expect(fundingInputs.minTurnCostNanoUsd).toBe(33n * NANO_PER_CENT);
  });

  it('feeds the RAW purchased balance to the core, preserving a negative sign', () => {
    // An overdrawn wallet keeps its sign so the core denies premium; the served
    // spendable (cushioned, possibly positive) must never stand in for it.
    const fundingInputs = deriveClientFundingInputs(
      input({
        tier: 'free',
        purchasedBalanceNanoUsd: -100n * NANO_PER_CENT,
        spendableNanoUsd: 40n * NANO_PER_CENT,
      })
    );
    expect(fundingInputs.callerOwnPurchasedBalanceNanoUsd).toBe(-100n * NANO_PER_CENT);
  });
});
