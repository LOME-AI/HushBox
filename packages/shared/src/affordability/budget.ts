/**
 * Pre-send notification assembly.
 *
 * `generateNotifications` decides WHICH conditions hold for a client billing
 * decision plus its context; every sentence it renders comes from the one copy
 * home in `notices.ts`, so this module chooses reasons and never words them.
 * Cost/affordability math lives in the canonical nano-USD estimator (this
 * directory's `estimate/`), not here.
 */

import { contextFillBand, isOverContextCapacity } from './capacity-band.ts';
import { LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD } from './constants.ts';
import { notices } from './notices.ts';
import type { Notice, NoticeReason } from './notices.ts';
import type { FundingSource, FundingVerdict, DenialReason } from './billing/client-billing.ts';

export type { BudgetError, MessageSegment } from './notices.ts';

export interface NotificationInput {
  /**
   * A funding VERDICT, never a `ResolveBillingResult`. Every sentence this
   * module derives describes the payer's money, and an absent funding read
   * established none of it — so the caller decides what an absent one means
   * and this function is never handed one to word.
   */
  billingResult: FundingVerdict;
  capacityPercent: number;
  /**
   * Output tokens the turn leaves for the ANSWER — its output-token pool less
   * the turn's pinned reasoning budget. The pool itself is the wrong
   * quantity to watch: reasoning tokens come out of it, so a pool well clear
   * of the threshold can still leave a reply the user would call cut short.
   */
  maxAnswerTokens: number;
  privilege?: 'read' | 'write' | 'admin' | 'owner';
  hasDelegatedBudget?: boolean;
}

/**
 * The producer's denial discriminator, mapped onto the shared vocabulary. Two
 * of them name a condition the turn arithmetic also names, and the mapping is
 * what makes the pre-send notice and the wire refusal read identically rather
 * than merely similarly.
 */
export const DENIAL_REASONS: Readonly<Record<DenialReason, NoticeReason>> = {
  premium_requires_balance: 'premium_requires_credit',
  insufficient_balance: 'insufficient_funds',
  negative_balance: 'balance_negative',
  insufficient_free_allowance: 'free_allowance_exhausted',
  trial_limit_exceeded: 'trial_message_cap_exceeded',
  guest_budget_exhausted: 'guest_no_group_budget',
};

/** Funding sources that are worth stating; the two paid ones speak for themselves. */
const FUNDING_SOURCE_REASONS: Readonly<Partial<Record<FundingSource, NoticeReason>>> = {
  free_allowance: 'free_allowance_pays',
  trial_fixed: 'trial_preview_pays',
};

/** Push non-blocking warning notifications (capacity + low balance). */
function pushWarningNotifications(
  reasons: NoticeReason[],
  capacityPercent: number,
  fundingSource: FundingSource | 'denied',
  maxAnswerTokens: number
): void {
  if (contextFillBand(capacityPercent) === 'nearly_full') {
    reasons.push('context_near_capacity');
  }
  if (
    fundingSource === 'personal_balance' &&
    maxAnswerTokens < LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD
  ) {
    reasons.push('answer_may_be_shortened');
  }
}

/**
 * Push info-level notices: which funding source is paying, and — when the
 * sender is about to be charged for a turn the conversation owner would
 * otherwise have funded — the affirmative pre-send disclosure §Notices 5
 * requires.
 *
 * The disclosure is driven by the result's `payerSwitch`, which is set only on
 * an approved fall-through and covers an allocation that ran out, one that was
 * never granted, and one too small for this turn alike. Reading the switch
 * rather than the presence of a budget row is what makes the never-allocated
 * sender told as well; and because a refusal never carries it, a blocked send
 * states its refusal instead of a charge that will not happen.
 *
 * The switch arrives from the surface that stamps it, not from the funding
 * core: the core still computes one on its own non-solo fall-through, but the
 * client shell does not carry it through, so the only producer of this input is
 * the caller that holds the served payer beside the group membership.
 */
function pushInfoNotifications(
  reasons: NoticeReason[],
  billingResult: FundingVerdict,
  hasDelegatedBudget: boolean | undefined
): void {
  if (billingResult.fundingSource === 'denied') return;

  const notice = FUNDING_SOURCE_REASONS[billingResult.fundingSource];
  if (notice) reasons.push(notice);

  if (billingResult.fundingSource === 'owner_balance' && hasDelegatedBudget === true) {
    reasons.push('group_budget_pays');
  }
  if (billingResult.payerSwitch !== undefined) {
    reasons.push('payer_switched_to_personal');
  }
}

/**
 * The one blocking reason for a turn whose funding and whose length may both be
 * unsatisfiable at once (§Notices 4). The funding floor is tested first: a
 * denial means either that the funding cannot cover a minimum answer or — for
 * the tier denials — that no balance and no shorter prompt unlocks the model at
 * all, so in both cases funding is the reason and length is not. Length answers
 * only when funding is not the reason.
 *
 * This is the same precedence the option-level path applies; it is enforced
 * here as well because this is the surface where both notices would otherwise
 * be rendered together, handing the user two non-dismissible demands whose
 * actions contradict each other.
 */
function blockingReason(
  billingResult: FundingVerdict,
  isOverCapacity: boolean
): NoticeReason | undefined {
  if (billingResult.fundingSource === 'denied') return DENIAL_REASONS[billingResult.reason];
  return isOverCapacity ? 'prompt_too_long' : undefined;
}

/**
 * Generate the notices for a billing decision and its context.
 *
 * Order is the blocking reason, then warnings, then informational notices, so
 * the thing that stops the send is read first.
 */
export function generateNotifications(input: NotificationInput): Notice[] {
  const { billingResult, capacityPercent, maxAnswerTokens, privilege, hasDelegatedBudget } = input;

  // A read-only member cannot send at all, so no funding notice is relevant and
  // the privilege block is the whole answer.
  if (privilege === 'read') return [notices('conversation_read_only')];

  const reasons: NoticeReason[] = [];
  const isDenied = billingResult.fundingSource === 'denied';
  const isOverCapacity = isOverContextCapacity(capacityPercent);

  const blocking = blockingReason(billingResult, isOverCapacity);
  if (blocking !== undefined) reasons.push(blocking);

  if (!isDenied && !isOverCapacity) {
    pushWarningNotifications(
      reasons,
      capacityPercent,
      billingResult.fundingSource,
      maxAnswerTokens
    );
  }

  pushInfoNotifications(reasons, billingResult, hasDelegatedBudget);

  return reasons.map((reason) => notices(reason));
}

/**
 * The composer's one notice stack (`docs/BILLING.md` §Notices & Refusals 4):
 * at most one blocking notice, leading, and the info notices under it in their
 * order. A warning never sits beside a block, since a send that cannot start
 * has no reply to cut short.
 *
 * The send refusal outranks the verdict's own blocking notice because the gate
 * reads the hold and the composed prompt, which the verdict cannot see; the two
 * can name different reasons for one cause, so deduplicating by id leaves both.
 * A negative balance the verdict names outranks any refusal: it blocks every
 * send until the user adds credit.
 */
export function composeComposerNotices(input: {
  /** The send gate's typed refusal, or `undefined` when the send may start. */
  readonly refusal: NoticeReason | undefined;
  /** {@link generateNotifications}' answer for the same turn. */
  readonly verdictNotices: readonly Notice[];
}): Notice[] {
  const { refusal, verdictNotices } = input;
  const negativeBalance = verdictNotices.find((notice) => notice.id === 'balance_negative');
  const sendBlock =
    refusal === undefined
      ? verdictNotices.find((notice) => notice.type === 'error')
      : notices(refusal);
  const blocking = negativeBalance ?? sendBlock;
  if (blocking === undefined) return [...verdictNotices];
  return [blocking, ...verdictNotices.filter((notice) => notice.type === 'info')];
}
