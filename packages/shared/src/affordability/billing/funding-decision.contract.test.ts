/**
 * The cross-side funding contract: the funding-decision matrix — solo,
 * group-member and link-guest scenarios alike — driven through the ONE
 * shared decision core. Both sides resolve their
 * primitives their own way — the chat slice (`resolvePayerWallet` + the tier
 * gate) from Postgres, the client (`resolveClientBilling` via
 * `deriveClientFundingInputs`) from its budgets / models endpoints — and then
 * call {@link resolveFunding}. Because there is a single decision
 * function, a scenario can be pinned once here and both sides are bound to the
 * same RULE; a change to that rule that split the two verdicts becomes a failure
 * of this table.
 *
 * What this table does NOT pin: that the two sides FEED the core the same inputs.
 * Every row hands the server leg a hand-written {@link FundingInputs} literal, so
 * a row's server inputs are what the chat slice COULD pass, never evidence of
 * what it does pass. The `minTurnCost` rows are where that matters — see the
 * note above them.
 *
 * Both legs are exercised:
 *  - the SERVER leg calls {@link resolveFunding} on the raw nano-USD
 *    {@link FundingInputs} (how the chat slice feeds it), and
 *  - the CLIENT leg feeds the equivalent nano-USD {@link ClientFundingContext}
 *    through the client's own {@link deriveClientFundingInputs} shell into the
 *    same core — proving the client production path lands on the identical
 *    decision.
 *
 * A scenario carries a client leg only where the client can REACH the verdict.
 * The client holds no group dimensions: a signed-in member's owner-funded
 * verdict is made server-side and arrives as a served payer, so those rows are
 * server-only and say so. What replaces the missing legs is stronger than they
 * were — a total assertion below that no signed-in {@link ClientFundingContext}
 * whatsoever resolves to `owner`, which the old group-bearing rows disproved.
 *
 * Trial funding (`trial_fixed`) is deliberately absent: it is a distinct funding
 * source gated by the trial quota policy, not a payer/premium decision, and it
 * never reaches this core.
 */
import { describe, expect, it } from 'vitest';
import { resolveFunding, type FundingDecision, type FundingInputs } from './funding-decision.ts';
import { deriveClientFundingInputs, type ClientFundingContext } from './client-billing.ts';

interface Scenario {
  readonly name: string;
  /** How the server (chat slice) feeds the core: raw nano-USD primitives. */
  readonly inputs: FundingInputs;
  /**
   * How the client feeds the core: served nano-USD primitives through its own
   * shell. Absent where the client cannot reach the scenario at all — it has no
   * group dimensions, so a signed-in member's owner-funded verdict is the
   * server's alone and reaches the client as a served payer instead.
   */
  readonly clientInputs?: ClientFundingContext;
  readonly expected: FundingDecision;
}

const ONE = 1_000_000n;

const MATRIX: readonly Scenario[] = [
  {
    name: 'owner solo, positive purchased balance → self / purchased, premium allowed',
    inputs: {
      isSolo: true,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'paid',
      purchasedBalanceNanoUsd: ONE,
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: {
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: undefined,
    },
  },
  {
    name: 'owner solo, zero purchased balance → self / free, premium denied',
    inputs: {
      isSolo: true,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 0n,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: {
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: undefined,
    },
  },
  {
    name: 'free-allowance user selecting a premium model → MODEL_TIER_LOCKED',
    inputs: {
      isSolo: true,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: 0n,
      ownerPurchasedBalanceNanoUsd: 0n,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: true,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: { payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' },
  },
  {
    name: 'member within budget (headroom > 0) → owner-funded / purchased',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    expected: {
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: ONE,
    },
  },
  {
    name: 'member within budget on a premium model → owner-funded (premium-exempt)',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: true,
      minTurnCostNanoUsd: 0n,
    },
    expected: {
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: ONE,
    },
  },
  {
    name: 'member over budget (headroom ≤ 0), positive own balance → self / purchased',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    expected: {
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    },
  },
  {
    name: 'member with no budget row (0 headroom), zero own balance → self / free',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    expected: {
      payer: 'self',
      walletKind: 'free',
      premiumAllowed: false,
      payerSwitch: 'group_headroom_insufficient',
    },
  },
  {
    name: 'link guest, headroom > 0 → owner-funded / purchased',
    inputs: {
      isSolo: false,
      isGuest: true,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'guest',
      purchasedBalanceNanoUsd: 0n,
      // A guest's served figure IS its headroom — one payer-scoped number, not
      // a group blob the client composes.
      spendableNanoUsd: ONE,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: {
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: ONE,
    },
  },
  {
    name: 'link guest, headroom ≤ 0 → refused (no wallet)',
    inputs: {
      isSolo: false,
      isGuest: true,
      memberRemainingNanoUsd: 0n,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: 0n,
    },
    clientInputs: {
      tier: 'guest',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: 0n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: 0n,
    },
    expected: { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' },
  },
  // The three rows below exercise §Funding Decision Matrix priority 1's
  // comparison. It is the SERVER leg that makes it, against the `minTurnCost`
  // the payer freeze prices; the client cannot express a
  // member's group dimensions, so only the guest row carries a client leg.
  {
    name: 'headroom exactly covering the turn minimum → owner-funded / purchased',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE,
      conversationRemainingNanoUsd: ONE,
      ownerPurchasedBalanceNanoUsd: ONE,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: ONE,
    },
    expected: {
      payer: 'owner',
      walletKind: 'purchased',
      premiumAllowed: true,
      spendableNanoUsd: ONE,
    },
  },
  {
    name: 'headroom one nano below the turn estimate → self / purchased, payer switched',
    inputs: {
      isSolo: false,
      isGuest: false,
      memberRemainingNanoUsd: ONE - 1n,
      conversationRemainingNanoUsd: ONE - 1n,
      ownerPurchasedBalanceNanoUsd: ONE - 1n,
      callerOwnPurchasedBalanceNanoUsd: ONE,
      isPremiumModel: false,
      minTurnCostNanoUsd: ONE,
    },
    expected: {
      payer: 'self',
      walletKind: 'purchased',
      premiumAllowed: true,
      payerSwitch: 'group_headroom_insufficient',
    },
  },
  {
    name: 'link guest, headroom below the turn estimate → refused (no wallet)',
    inputs: {
      isSolo: false,
      isGuest: true,
      memberRemainingNanoUsd: ONE - 1n,
      conversationRemainingNanoUsd: ONE - 1n,
      ownerPurchasedBalanceNanoUsd: ONE - 1n,
      callerOwnPurchasedBalanceNanoUsd: 0n,
      isPremiumModel: false,
      minTurnCostNanoUsd: ONE,
    },
    clientInputs: {
      tier: 'guest',
      purchasedBalanceNanoUsd: 0n,
      spendableNanoUsd: ONE - 1n,
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: ONE,
    },
    expected: { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' },
  },
];

const CLIENT_REACHABLE = MATRIX.filter(
  (scenario): scenario is Scenario & { clientInputs: ClientFundingContext } =>
    scenario.clientInputs !== undefined
);

describe('funding-decision matrix contract', () => {
  it.each(MATRIX)('server leg — $name', ({ inputs, expected }) => {
    expect(resolveFunding(inputs)).toEqual(expected);
  });

  it.each(CLIENT_REACHABLE)('client leg — $name', ({ clientInputs, expected }) => {
    // The client's production shell (deriveClientFundingInputs) feeds the SAME
    // core, so its decision must match the server's for the same scenario.
    expect(resolveFunding(deriveClientFundingInputs(clientInputs))).toEqual(expected);
  });

  it('binds both sides — client and server resolve every reachable scenario identically', () => {
    for (const { inputs, clientInputs } of CLIENT_REACHABLE) {
      expect(resolveFunding(deriveClientFundingInputs(clientInputs))).toEqual(
        resolveFunding(inputs)
      );
    }
  });

  it('the client leg covers every scenario a client can reach — only member rows are server-only', () => {
    // Guards the filter above from silently swallowing a row: a scenario losing
    // its client leg for any reason other than needing group dimensions would
    // shrink the client's proven surface without anything going red.
    const serverOnly = MATRIX.filter((scenario) => scenario.clientInputs === undefined).map(
      (scenario) => scenario.name
    );
    expect(serverOnly).toEqual([
      'member within budget (headroom > 0) → owner-funded / purchased',
      'member within budget on a premium model → owner-funded (premium-exempt)',
      'member over budget (headroom ≤ 0), positive own balance → self / purchased',
      'member with no budget row (0 headroom), zero own balance → self / free',
      'headroom exactly covering the turn minimum → owner-funded / purchased',
      'headroom one nano below the turn estimate → self / purchased, payer switched',
    ]);
  });
});

describe('the client cannot reassemble an owner-funded verdict', () => {
  // What the deleted group-bearing client legs used to demonstrate, inverted
  // into the guarantee that replaced them: an owner verdict on the client is
  // reachable ONLY through the guest arm, whose served figure IS the headroom.
  // Signed-in tiers resolve the solo arm whatever their funding figures, so a
  // second client-side funding authority cannot be built out of this shell.
  const SIGNED_IN: readonly ClientFundingContext['tier'][] = ['free', 'paid'];
  const AMOUNTS = [0n, ONE, 1_000_000_000n];

  it.each(SIGNED_IN)('%s resolves the solo arm for every funding figure', (tier) => {
    for (const purchased of AMOUNTS) {
      for (const spendable of AMOUNTS) {
        const inputs = deriveClientFundingInputs({
          tier,
          purchasedBalanceNanoUsd: purchased,
          spendableNanoUsd: spendable,
          isPremiumModel: false,
          estimatedMinimumCostNanoUsd: 0n,
        });
        expect(inputs.isSolo).toBe(true);
        expect(resolveFunding(inputs).payer).toBe('self');
      }
    }
  });
});
