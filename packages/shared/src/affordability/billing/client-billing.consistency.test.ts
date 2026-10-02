/**
 * The client's pre-send outcome table: `resolveClientBilling` and
 * `generateNotifications` over one scenario matrix, pinned as WHOLE outcomes.
 *
 * Every row declares the produced billing decision and the produced notice list
 * as VALUES, and each is compared with `toEqual`. That is the whole point of the
 * shape: a row's name claims a specific outcome ("denied because the model is
 * premium"), and only a whole-outcome comparison makes the name and the
 * assertion the same claim. A predicate over the outcome — "some blocking error
 * is present" — is satisfied by every denial alike, so it holds while the
 * refusal names the wrong reason and while the notice list carries extra
 * entries. Two of these rows deny for a reason their names did not name.
 *
 * The shape follows `funding-decision.contract.test.ts`, which pins the funding
 * core's matrix the same way.
 *
 * The relation between the two functions — a denial always blocks the send, an
 * approval never does — is asserted ONCE over the whole table, which is where a
 * relation belongs. It is deliberately not the per-row assertion: a relation
 * holds equally for a row whose outcome is wrong.
 *
 * Copy is not restated here. Each expectation names the reason, and the notice
 * that reason mints comes from `notices.ts`, its one copy home.
 */

import { describe, it, expect } from 'vitest';

import { DENIAL_REASONS, generateNotifications, type NotificationInput } from '../budget.ts';
import { notices, type Notice, type NoticeReason } from '../notices.ts';
import {
  resolveClientBilling,
  type ClientBillingInput,
  type ResolveBillingResult,
} from './client-billing.ts';

/** Cents → nano-USD for readable fixtures; served spendable = balance + the baked 50¢ cushion. */
const NANO_PER_CENT = 10_000_000n;
const nano = (cents: number): bigint => BigInt(cents) * NANO_PER_CENT;
const spendableFor = (cents: number): bigint => nano(cents + 50);

/** The notice context around the decision; a row overrides only what it varies. */
type NoticeContext = Omit<NotificationInput, 'billingResult'>;

/** Neither over capacity nor short on output tokens, so no warning fires. */
const QUIET_CONTEXT: NoticeContext = { capacityPercent: 20, maxAnswerTokens: 50_000 };

interface Scenario {
  readonly name: string;
  readonly input: ClientBillingInput;
  readonly context?: Partial<NoticeContext>;
  readonly expectedBilling: ResolveBillingResult;
  /** In render order: the blocking reason first, then warnings, then info. */
  readonly expectedNotices: readonly NoticeReason[];
}

const MATRIX: readonly Scenario[] = [
  {
    name: 'paid, balance covers the turn → the personal balance pays, silently',
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(1000),
      spendableNanoUsd: spendableFor(1000),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'personal_balance' },
    expectedNotices: [],
  },
  {
    name: 'paid on a premium model, balance covers it → the purchased balance unlocks the tier',
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(1000),
      spendableNanoUsd: spendableFor(1000),
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'personal_balance' },
    expectedNotices: [],
  },
  {
    name: 'paid, spendable below the estimate → refused for funds',
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(200),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'insufficient_balance' },
    expectedNotices: ['insufficient_funds'],
  },
  {
    name: 'paid on a premium model with a zero purchased balance → refused for the TIER, not for funds',
    // The tier gate resolves first, so the reason is the one whose action helps:
    // this send is refused because nothing was ever purchased, and it stays
    // refused at an estimate the balance could have covered.
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: nano(200),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'premium_requires_balance' },
    expectedNotices: ['premium_requires_credit'],
  },
  {
    name: 'free, allowance covers the turn → the allowance pays, and says so',
    input: {
      tier: 'free',
      purchasedBalanceNanoUsd: nano(0),
      // A free payer's served spendable IS the day-keyed allowance remaining,
      // hold-aware and cushion-free — not a purchased balance plus cushion.
      spendableNanoUsd: nano(100),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'free_allowance' },
    expectedNotices: ['free_allowance_pays'],
  },
  {
    name: 'free, allowance spent → refused for the allowance, never for a balance',
    input: {
      tier: 'free',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'insufficient_free_allowance' },
    expectedNotices: ['free_allowance_exhausted'],
  },
  {
    name: 'free on a premium model, allowance intact → refused for the tier',
    input: {
      tier: 'free',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(100),
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'premium_requires_balance' },
    expectedNotices: ['premium_requires_credit'],
  },
  {
    name: 'trial, estimate at the per-message ceiling → the trial pays, and says so',
    input: {
      tier: 'trial',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(1),
    },
    expectedBilling: { fundingSource: 'trial_fixed' },
    expectedNotices: ['trial_preview_pays'],
  },
  {
    name: 'trial, estimate above the per-message ceiling → refused on the trial cap',
    input: {
      tier: 'trial',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'trial_limit_exceeded' },
    expectedNotices: ['trial_message_cap_exceeded'],
  },
  {
    name: 'trial on a premium model within the ceiling → refused for the tier, not the cap',
    input: {
      tier: 'trial',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: nano(1),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'premium_requires_balance' },
    expectedNotices: ['premium_requires_credit'],
  },
  {
    name: 'guest served zero headroom → refused as a guest with no group budget',
    // Unallocated and exhausted are the same input at this seam: a guest's served
    // figure is the owner-funded headroom, already clamped, and both shapes serve
    // zero. The distinction lives where the figure is computed, not here.
    input: {
      tier: 'guest',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(1),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
    expectedNotices: ['guest_no_group_budget'],
  },
  {
    name: 'guest whose headroom covers the turn → the owner pays',
    input: {
      tier: 'guest',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(500),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(1),
    },
    expectedBilling: { fundingSource: 'owner_balance' },
    expectedNotices: [],
  },
  {
    name: 'guest on a premium model the headroom covers → owner-funded turns are tier-exempt',
    input: {
      tier: 'guest',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(500),
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: nano(1),
    },
    expectedBilling: { fundingSource: 'owner_balance' },
    expectedNotices: [],
  },
  {
    name: 'guest funded by a delegated budget → the owner pays, and the delegation is stated',
    input: {
      tier: 'guest',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(500),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(1),
    },
    context: { hasDelegatedBudget: true },
    expectedBilling: { fundingSource: 'owner_balance' },
    expectedNotices: ['group_budget_pays'],
  },
  {
    name: 'guest whose delegated budget is spent → refused, and the delegation notice is not rendered',
    input: {
      tier: 'guest',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    context: { hasDelegatedBudget: true },
    expectedBilling: { fundingSource: 'denied', reason: 'guest_budget_exhausted' },
    expectedNotices: ['guest_no_group_budget'],
  },
  {
    name: 'guest on a delegated budget with a priced turn it covers → the owner pays',
    input: {
      tier: 'guest',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: nano(500),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    context: { hasDelegatedBudget: true },
    expectedBilling: { fundingSource: 'owner_balance' },
    expectedNotices: ['group_budget_pays'],
  },
  {
    name: 'read-only member on a funded turn → the privilege block is the whole answer',
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(1000),
      spendableNanoUsd: spendableFor(1000),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    context: { privilege: 'read' },
    expectedBilling: { fundingSource: 'personal_balance' },
    expectedNotices: ['conversation_read_only'],
  },
  {
    name: 'write-privileged member who cannot afford the turn → refused for funds',
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(200),
    },
    context: { privilege: 'write' },
    expectedBilling: { fundingSource: 'denied', reason: 'insufficient_balance' },
    expectedNotices: ['insufficient_funds'],
  },
  {
    name: 'funded turn over capacity → the length demand alone',
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(1000),
      spendableNanoUsd: spendableFor(1000),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    context: { capacityPercent: 150 },
    expectedBilling: { fundingSource: 'personal_balance' },
    expectedNotices: ['prompt_too_long'],
  },
  {
    name: 'refused turn over capacity → the funding reason alone, per §Notices 4',
    // Both bind, so the precedence picks one: the funding floor is tested first,
    // and a length demand alongside it would contradict its action.
    input: {
      tier: 'paid',
      purchasedBalanceNanoUsd: nano(0),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(200),
    },
    context: { capacityPercent: 150, maxAnswerTokens: 0 },
    expectedBilling: { fundingSource: 'denied', reason: 'insufficient_balance' },
    expectedNotices: ['insufficient_funds'],
  },
  {
    name: 'balance below zero on a basic model → refused for the negative balance',
    input: {
      tier: 'free',
      purchasedBalanceNanoUsd: nano(-250),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: false,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'negative_balance' },
    expectedNotices: ['balance_negative'],
  },
  {
    name: 'balance below zero on a premium model → refused for the negative balance, not the tier',
    input: {
      tier: 'free',
      purchasedBalanceNanoUsd: nano(-250),
      spendableNanoUsd: spendableFor(0),
      isPremiumModel: true,
      estimatedMinimumCostNanoUsd: nano(10),
    },
    expectedBilling: { fundingSource: 'denied', reason: 'negative_balance' },
    expectedNotices: ['balance_negative'],
  },
];

/**
 * The typed reasons a billing denial resolves to; each one blocks the send.
 * Read off the reason map the notices are produced through, so a denial reason
 * added there is in this set without an edit here.
 */
const DENIAL_NOTICES: ReadonlySet<NoticeReason> = new Set<NoticeReason>(
  Object.values(DENIAL_REASONS)
);

function noticesFor(scenario: Scenario): Notice[] {
  return generateNotifications({
    billingResult: resolveClientBilling(scenario.input),
    ...QUIET_CONTEXT,
    ...scenario.context,
  });
}

describe('resolveClientBilling and generateNotifications, as whole outcomes', () => {
  it.each(MATRIX)('$name — resolves exactly that billing decision', (scenario) => {
    expect(resolveClientBilling(scenario.input)).toEqual(scenario.expectedBilling);
  });

  it.each(MATRIX)('$name — renders exactly those notices, in order', (scenario) => {
    expect(noticesFor(scenario)).toEqual(scenario.expectedNotices.map((reason) => notices(reason)));
  });

  it('blocks every denied send and no approved one', () => {
    for (const scenario of MATRIX) {
      const blocked = noticesFor(scenario).some(
        (notice) => notice.type === 'error' && DENIAL_NOTICES.has(notice.id)
      );
      expect({ name: scenario.name, blocked }).toEqual({
        name: scenario.name,
        blocked: scenario.expectedBilling.fundingSource === 'denied',
      });
    }
  });
});
