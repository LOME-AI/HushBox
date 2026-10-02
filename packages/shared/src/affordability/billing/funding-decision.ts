/**
 * The pure funding + premium-tier decision — the single source of truth for
 * two questions a chat turn must answer before it runs: WHO pays (which
 * wallet), and WHETHER a premium model is permitted. It is the "functional
 * core": no DB, no I/O, no Zod — only the primitive balances and flags the
 * caller has already resolved. Both the server (the chat slice, from Postgres)
 * and the client (from its budgets / models endpoints) resolve those primitives
 * their own way and then call THIS function. The chat slice's
 * `resolvePayerWallet` and tier gate are its imperative shells; a contract
 * test pins the funding-decision matrix — solo, group-member and link-guest
 * scenarios alike — against it.
 *
 * Priority 1's comparison is what makes the send path able to run this core at
 * all: it consumes `minTurnCost` — a BOUND on the turn, with no payer term in
 * it — never a full estimate, whose ceiling is bounded by the payer's
 * own funding and therefore cannot be known before the payer is. One pass, no
 * circularity (§Math & Terms).
 *
 * The branching it encodes is exactly what previously lived inline in the chat
 * slice: the clamp-then-min group headroom, purchased-then-free wallet
 * selection, the owner-funded premium exemption, and the
 * `canAccessPremium = own purchased > 0` gate.
 */

import { spendableFundsNanoUsd } from '../estimate/pre-adapters.ts';

/**
 * The primitive inputs the decision reads — all already resolved by the caller.
 * Balances are nano-USD `bigint`. `memberRemainingNanoUsd` is `0n` for an absent
 * `member_budgets` row (a missing cap is zero headroom, never unlimited).
 * `isPremiumModel` is the caller's premium classification of the selected
 * model(s) — the server does not consult it when it only needs the payer.
 */
export interface FundingInputs {
  /** The sender is the conversation owner (a solo turn) — always self-funded. */
  readonly isSolo: boolean;
  /** The sender is a link guest, which holds no wallet and cannot self-fund. */
  readonly isGuest: boolean;
  /** Sender's remaining per-member budget (cap − spent); `0n` when no row. */
  readonly memberRemainingNanoUsd: bigint;
  /** Conversation's remaining budget (cap − spent). */
  readonly conversationRemainingNanoUsd: bigint;
  /**
   * Owner's RAW purchased-wallet balance (the only pool group turns draw from).
   * Raw on purpose: {@link groupHeadroom} applies the cushion, so this is the
   * one place it lands and no caller applies it first. A caller holding only a
   * served group headroom cannot be double-cushioned by that, whichever
   * dimensions it puts the served figure in: that figure is itself a min over the
   * same read's clamped owner balance, so it can never exceed that balance plus a
   * cushion, and the min it enters stays the served figure.
   */
  readonly ownerPurchasedBalanceNanoUsd: bigint;
  /** Caller's own purchased-wallet balance — gates self-funding and premium. */
  readonly callerOwnPurchasedBalanceNanoUsd: bigint;
  /** Whether the selected model is premium-tier. */
  readonly isPremiumModel: boolean;
  /**
   * `minTurnCost` — the least this turn could cost, the same whoever pays,
   * which the group headroom must cover for the owner to fund it (BILLING
   * §Funding Decision Matrix priority 1). Headroom that cannot cover the
   * minimum can never cover the turn, so a signed-in sender falls through to
   * personal funds and a guest is refused.
   *
   * `undefined` means the CALLER could not put a minimum on the table — never
   * that the turn has none, and never that a KIND of turn is exempt. Each shape
   * prices through the producer that owns it — the summed-rate corner for text,
   * the per-unit price for media, the balance-independent pool threshold for a
   * Smart Model slot — and all three reach `undefined` identically, when nothing
   * prices: a selected model the exposed catalog does not carry, or one missing
   * a per-token rate, a unit price, or a context length; or a candidate pool
   * that prices no member — or prices every member and leaves none of them room
   * for a minimum answer at this prompt. Such a send is refused before any spend
   * whichever leg is missing — at the turn build, or at admission for a
   * selection the build still compiles — so who would have paid never matters.
   * The other way is a caller pricing no turn at all — the served funding
   * snapshot names the payer for a composer that has no prompt yet. Both
   * leave priority 1's comparison inapplicable. It is deliberately not an
   * amount (an unreachable minimum must not be mistaken for a zero one), and
   * exempting a shape from it would freeze the owner on headroom that cannot
   * cover the turn — the permanent refusal priority 1 exists to close.
   */
  readonly minTurnCostNanoUsd: bigint | undefined;
}

/**
 * Why a group turn's payer changed to the sender. One typed value covers both
 * shapes — an allowance that ran out and one that was never granted — because
 * §Notices 5's disclosure is the same in both: the sender is about to be
 * charged. Copy derives from this reason in one place (§Notices 1), never from a
 * boolean a surface interprets for itself.
 */
export type PayerSwitchReason = 'group_headroom_insufficient';

/**
 * The decision. `self` — the caller pays their own wallet (`purchased` while it
 * carries a positive balance, else the `free` daily-allowance wallet); its
 * `premiumAllowed` mirrors the tier gate. `owner` — an owner-funded group turn
 * draws the owner's purchased wallet and is premium-exempt by construction.
 * `refuse` — the turn cannot be funded/allowed: `GROUP_BUDGET_EXHAUSTED` (a link
 * guest with no headroom and no wallet) or `MODEL_TIER_LOCKED` (a self-funding
 * caller with no purchased balance selecting a premium model).
 */
export type FundingDecision =
  | {
      readonly payer: 'self';
      readonly walletKind: 'purchased' | 'free';
      readonly premiumAllowed: boolean;
      /**
       * Set only when a group turn's headroom could not cover it, so the sender
       * pays instead of the owner — the pre-send disclosure §Notices 5 requires.
       * `undefined` on a turn that was self-funded all along.
       */
      readonly payerSwitch: PayerSwitchReason | undefined;
    }
  | {
      readonly payer: 'owner';
      readonly walletKind: 'purchased';
      readonly premiumAllowed: true;
      /**
       * The headroom this verdict was reached on — what an owner-funded turn may
       * spend. It rides the decision rather than being recomputed by the caller
       * because the freeze and the ceiling solve must consult ONE value: a
       * second min over the same dimensions is a copy that has to agree to be
       * correct, and the two disagreeing by the cushion is precisely how a
       * member who cleared the freeze was then refused at admission.
       */
      readonly spendableNanoUsd: bigint;
    }
  | {
      readonly payer: 'refuse';
      readonly refusalCode: 'GROUP_BUDGET_EXHAUSTED' | 'MODEL_TIER_LOCKED';
    };

function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/** The group dimension whose clamped value bounds an owner-funded turn. */
export type OwnerFundingLimit = 'owner_balance' | 'member_allocation' | 'conversation_budget';

/** One group dimension's clamped value, labelled with the limit it stands for. */
interface GroupTerm {
  readonly limit: OwnerFundingLimit;
  readonly nanoUsd: bigint;
}

/**
 * The three clamped dimensions, in tie-break order: {@link bindingTerm} keeps
 * the earliest of equal terms, so a tie names the owner's balance before the
 * member allocation, and the member allocation before the conversation budget.
 */
function groupTerms(
  memberRemainingNanoUsd: bigint,
  conversationRemainingNanoUsd: bigint,
  ownerPurchasedBalanceNanoUsd: bigint
): readonly [GroupTerm, GroupTerm, GroupTerm] {
  return [
    {
      limit: 'owner_balance',
      nanoUsd: clampNonNegative(spendableFundsNanoUsd(ownerPurchasedBalanceNanoUsd)),
    },
    { limit: 'member_allocation', nanoUsd: clampNonNegative(memberRemainingNanoUsd) },
    { limit: 'conversation_budget', nanoUsd: clampNonNegative(conversationRemainingNanoUsd) },
  ];
}

/** The smallest term; the earliest wins a tie. */
function bindingTerm(terms: readonly [GroupTerm, GroupTerm, GroupTerm]): GroupTerm {
  const [first, ...rest] = terms;
  let binding = first;
  for (const term of rest) {
    if (term.nanoUsd < binding.nanoUsd) binding = term;
  }
  return binding;
}

/**
 * The spendable group headroom: the smallest of the three dimensions, each
 * clamped to ≥ 0 first so an overspent or absent dimension reads as zero and
 * cannot be masked by a larger sibling.
 *
 * THE one answer to "what may this group turn spend", and the reason it is
 * exported: the decision below, the served figure, and the group-budget display
 * all consult it, so no two of them can price the same three dimensions
 * differently. A second min over these dimensions would be a copy that has to
 * agree to be correct, which is how a served figure and admission came to
 * disagree by the width of the cushion (`docs/BILLING.md` §Affordability 8,
 * §Group Funding 6(b)).
 *
 * The owner dimension enters as the owner wallet's SPENDABLE funds — balance
 * plus the cushion it carries — from the one function that answers that
 * question. The cushion belongs to the wallet, not to the transaction, so the
 * same money must fund the same turn whoever sends it: an owner able to overdraw
 * for their own turn is able to overdraw for a member's. Putting it inside the
 * min rather than on top of it keeps each cap an independent bound, so no
 * cushion can lift a member above the allocation the owner granted them.
 *
 * Passing an already-cushioned figure in as the owner dimension cannot
 * double-cushion the result: the caller that does so (a link guest, whose served
 * figure IS this function's output) puts that figure in every dimension, and a
 * cushion only ever raises the owner term, so the min stays the figure.
 */
export function groupHeadroom(
  memberRemainingNanoUsd: bigint,
  conversationRemainingNanoUsd: bigint,
  ownerPurchasedBalanceNanoUsd: bigint
): bigint {
  return bindingTerm(
    groupTerms(memberRemainingNanoUsd, conversationRemainingNanoUsd, ownerPurchasedBalanceNanoUsd)
  ).nanoUsd;
}

/**
 * The five figures a hold-aware group headroom is composed from: each scoped
 * cap's remaining allowance, the amount that scope's own in-flight runs have
 * reserved, and the owner's raw purchased balance.
 */
export interface HoldAwareGroupDimensions {
  /** Sender's per-member allowance, cap − spent; `0n` when no row exists. */
  readonly memberRemainingNanoUsd: bigint;
  /** What the member scope's own active holds have reserved. */
  readonly memberHeldNanoUsd: bigint;
  /** Conversation allowance, cap − spent. */
  readonly conversationRemainingNanoUsd: bigint;
  /** What the conversation scope's own active holds have reserved. */
  readonly conversationHeldNanoUsd: bigint;
  /** Owner's RAW purchased balance — {@link groupHeadroom} adds the cushion. */
  readonly ownerPurchasedBalanceNanoUsd: bigint;
}

/**
 * {@link groupHeadroom} with the active holds taken off. THE one composition of
 * the two, and the reason it is a function rather than three subtractions at
 * each call site: which scope's hold reduces which dimension, and that both are
 * applied BEFORE the min rather than after it, are decisions that must be made
 * identically by the served funding snapshot and the group-budget display. Two
 * hand-written compositions can drift while both still call the same min, which
 * is the drift `docs/BILLING.md` §Affordability 8 records the cost of.
 *
 * The owner dimension takes no subtraction: an owner's holds are their own
 * wallet's business, and a hold the owner placed on an unrelated conversation
 * must not shrink what a member here may spend.
 */
export function holdAwareGroupHeadroom(dimensions: HoldAwareGroupDimensions): bigint {
  return bindingTerm(holdAwareTerms(dimensions)).nanoUsd;
}

/**
 * Which dimension {@link holdAwareGroupHeadroom}'s figure comes from. It reads
 * the same terms and the same minimum, so the limit named and the figure served
 * cannot describe different dimensions.
 */
export function bindingGroupLimit(dimensions: HoldAwareGroupDimensions): OwnerFundingLimit {
  return bindingTerm(holdAwareTerms(dimensions)).limit;
}

function holdAwareTerms(
  dimensions: HoldAwareGroupDimensions
): readonly [GroupTerm, GroupTerm, GroupTerm] {
  return groupTerms(
    dimensions.memberRemainingNanoUsd - dimensions.memberHeldNanoUsd,
    dimensions.conversationRemainingNanoUsd - dimensions.conversationHeldNanoUsd,
    dimensions.ownerPurchasedBalanceNanoUsd
  );
}

/**
 * Whether the owner funds the turn: headroom remains AND it covers the turn's
 * minimum. Both clauses are load-bearing — exhausted headroom is never fundable
 * whatever the minimum, and headroom that cannot cover this turn is not fundable
 * however positive it is (the failure this comparison exists to catch: a
 * remainder too small to answer with, frozen as owner-funded and then refused at
 * admission, deterministically, for as long as the remainder stands). An
 * unpriced turn has no comparison to apply.
 */
function coversTurn(headroom: bigint, minTurnCostNanoUsd: bigint | undefined): boolean {
  if (headroom <= 0n) return false;
  return minTurnCostNanoUsd === undefined || headroom >= minTurnCostNanoUsd;
}

/**
 * Self-funding: purchased wallet while positive, else the free wallet. Premium
 * is allowed exactly when the caller's own purchased balance is positive; a
 * premium selection without it is the `MODEL_TIER_LOCKED` refusal — which
 * carries no payer-switch disclosure, because a refused send has a refusal
 * notice instead.
 */
function selfFunding(
  callerOwnPurchasedBalanceNanoUsd: bigint,
  isPremiumModel: boolean,
  payerSwitch?: PayerSwitchReason
): FundingDecision {
  const canAccessPremium = callerOwnPurchasedBalanceNanoUsd > 0n;
  if (isPremiumModel && !canAccessPremium) {
    return { payer: 'refuse', refusalCode: 'MODEL_TIER_LOCKED' };
  }
  return {
    payer: 'self',
    walletKind: canAccessPremium ? 'purchased' : 'free',
    premiumAllowed: canAccessPremium,
    payerSwitch,
  };
}

/**
 * Resolve the funding + premium decision. A solo turn always self-funds. A
 * non-solo turn whose group headroom covers the turn is owner-funded
 * (premium-exempt); headroom that does not cover it refuses a link guest and
 * falls a signed-in member through to self-funding, carrying the payer-switch
 * reason.
 */
export function resolveFunding(inputs: FundingInputs): FundingDecision {
  if (!inputs.isSolo) {
    const effective = groupHeadroom(
      inputs.memberRemainingNanoUsd,
      inputs.conversationRemainingNanoUsd,
      inputs.ownerPurchasedBalanceNanoUsd
    );
    if (coversTurn(effective, inputs.minTurnCostNanoUsd)) {
      return {
        payer: 'owner',
        walletKind: 'purchased',
        premiumAllowed: true,
        spendableNanoUsd: effective,
      };
    }
    if (inputs.isGuest) {
      return { payer: 'refuse', refusalCode: 'GROUP_BUDGET_EXHAUSTED' };
    }
    return selfFunding(
      inputs.callerOwnPurchasedBalanceNanoUsd,
      inputs.isPremiumModel,
      'group_headroom_insufficient'
    );
  }
  return selfFunding(inputs.callerOwnPurchasedBalanceNanoUsd, inputs.isPremiumModel);
}
