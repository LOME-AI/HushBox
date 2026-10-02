import * as React from 'react';
import {
  buildTurnSystemPrompt,
  composeComposerNotices,
  contextFillBand,
  generateNotifications,
  isOverContextCapacity,
  isTransientBlock,
  promptCharacterCount,
  reasoningBudgetForTurn,
  utcDayKey,
  type Model,
  type BudgetError,
  type ChatModality,
  type FundingSource,
  type MemberPrivilege,
  type PayerSwitchReason,
  type ReasoningEffortSelection,
  type ResolvedReasoningEffort,
} from '@hushbox/shared';
import { useBudgetCalculation } from '@/hooks/billing/use-budget-calculation';
import {
  useConversationBudgets,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets';
import { selectedServedRows, useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';
import { useMediaTurnOptions } from '@/hooks/billing/use-media-turn-options';
import { useResolveBilling } from '@/hooks/billing/use-resolve-billing';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useSession, useAuthStore, selectInstructionsReadUnresolved } from '@/lib/auth/auth';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useTurnOptions } from '@/hooks/billing/use-turn-options.js';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import type { ResolveBillingResult } from '@hushbox/shared';
import type {
  ContextFillBand,
  DimensionAvailability,
  MediaTurnOptions,
  NoticeReason,
  PromptBasis,
  TurnOptions,
} from '@hushbox/shared';

interface PromptBudgetInput {
  value: string;
  historyCharacters: number;
  /** Conversation ID for group budget lookup. Omit or null for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
  /**
   * Effective reasoning-effort selection for the composer. An explicit level
   * takes its shared-plan reasoning budget (the largest across the selected
   * models) out of the output-token pool, which shrinks `maxAnswerTokens`.
   * `off` and `auto` take none here: `auto` resolves server-side. Omit when the
   * selected model has no reasoning support.
   */
  reasoningEffort?: ReasoningEffortSelection;
}

/**
 * The turn's funding answer. `no_verdict` is not a denial and not a zero: no
 * funding figure was read for this payer, or the turn has no price to check one
 * against. Every consumer must branch on it before acting — nothing may start a
 * paid turn on it and nothing may word a money sentence from it. A consumer that
 * reads only the send refusal has not branched on it.
 */
type PromptFundingAnswer = FundingSource | 'denied' | 'no_verdict';

export interface PromptBudgetResult {
  fundingSource: PromptFundingAnswer;
  /** The funding verdict's notices alone, without the send refusal. */
  notifications: BudgetError[];
  /**
   * The composer's whole stack, from {@link composeComposerNotices}: the send
   * refusal and the verdict's notices merged into at most one blocking notice.
   */
  notices: readonly BudgetError[];
  /**
   * The payer change this turn would carry, as the typed reason rather than the
   * sentence built from it. It is published because a deferred send has to
   * compare the payer it was accepted under against the one resolved when it
   * finally goes out, and recovering that from the rendered notice list would
   * tie a money comparison to the wording.
   */
  payerSwitch: PayerSwitchReason | undefined;
  capacityPercent: number;
  /**
   * Which band that fill is in, produced rather than compared here. The same
   * verdict decides the near-capacity notice, so the bar and the warning cannot
   * cross the red line at different fills — which they did while the bar banded
   * on the whole percent it displays.
   */
  capacityBand: ContextFillBand;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
  /**
   * The turn's estimated minimum cost, exact nano-USD (decision domain — never
   * displayed), or `undefined` when the turn has NO price: nothing selected, a
   * model the catalog has not delivered, or a media rate the catalog does not
   * carry. A consumer must branch on the absence — comparing a zero in its place
   * answers "affordable" for a turn nobody could price.
   */
  estimatedCostNanoUsd: bigint | undefined;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  /**
   * The send-gate verdict for a send DEFERRED past the reply in flight, answered
   * conservatively: true for every block except a refusal DECLARED to end on its
   * own, and a funding read still settling — neither with a verdict-level block
   * raised beside it. Queueing defers a send rather than making one, and
   * refusing the queue on a block that ends by itself disabled it in exactly the
   * window a queue is for.
   *
   * Which refusals end on their own is {@link isTransientBlock}, declared once
   * beside the reason and read by the drain too — one classification, not two
   * lists. The safety property is one-directional and holds for BOTH exceptions:
   * whatever this side drops as self-clearing, the drain waits on rather than
   * hands back. A transient refusal and an absent funding verdict each reach the
   * drain's wait arm by name, and a bare state block reaches its final one.
   *
   * Only the send gate may act on this; it is never a funding verdict and never
   * widens what may be spent.
   */
  hasPersistentBlockingError: boolean;
  /**
   * Why the send is refused, as a TYPED reason, or `undefined` when it may
   * start. It is the producer's own refusal — NOT an inference from the gap
   * between the two sets, which cannot distinguish a hold from a long prompt
   * because the sets differ in funding AND basis. See {@link sendRefusalOf}.
   */
  sendRefusal: NoticeReason | undefined;
  /**
   * Whether anything this turn is priced from is still in flight. One term of
   * {@link hasBlockingError},
   * published separately because that flag cannot distinguish a read still
   * settling from a refusal. It is the send control's busy state, never a
   * funding verdict and never a reason to spend.
   *
   * `fundingSource === 'no_verdict'` is NOT this signal and must not be
   * substituted for it: that arm covers an exhausted read as well as a settling
   * one, and an exhausted read is the `send_check_unavailable` refusal.
   *
   * Nor does this signal answer "still settling" on its own. The catalog
   * publishes no rows whether its read is coming or gone, so an exhausted
   * catalog read is true here AND carries that refusal; the two are read
   * together or not at all.
   */
  isBillingLoading: boolean;
  hasContent: boolean;
  /**
   * Whether the turn's affordability producer has left its pending state: the
   * payer's funding snapshot is served, terminally unavailable, or the caller
   * holds no funding door, AND the catalog has landed. Resolved, not answered —
   * an exhausted read is settled and carries no verdict.
   *
   * It is a READOUT for tests, published because every affordability surface
   * renders neutral until the producer resolves and neutral is indistinguishable
   * from a verdict. Nothing may gate a send or word a money sentence from it:
   * {@link PromptBudgetResult.fundingSource} is the verdict and
   * {@link PromptBudgetResult.isBillingLoading} is the busy state.
   */
  isAffordabilitySettled: boolean;
  /**
   * The turn's output-token pool and the prompt's estimated input tokens, from
   * the shared budget core; the pool reads 0 while the composer is unpriced.
   */
  maxOutputTokens: number;
  estimatedInputTokens: number;
  /**
   * The media pair for the turn being composed, or `undefined` for a text turn
   * and while its inputs load. The panel greys its axis options off
   * `affordable`; the send gate above reads `admissible`. One call yields both,
   * so a greyed option and a refused send cannot disagree.
   */
  mediaOptions: MediaTurnOptions | undefined;
  /**
   * The produced effort dimension off `affordable` — the menu's presented set.
   * It rides the greying set, not the hold-aware one, because a hold blocks the
   * SEND and never greys an option (BILLING §Notices 9).
   *
   * This hook only RETURNS it. The verdict reaches the effort store through the
   * composer's own control alone — several instances of this hook are live at
   * once (composer, regenerate gate, drain gate) and they are scoped to
   * DIFFERENT payers, so a second writer would lower the composer's effort
   * against funds that are not the payer's.
   */
  effortDimension: DimensionAvailability | undefined;
}

function resolveGroupBudgetArgument(
  isGroupMember: boolean,
  conversationId: string | null | undefined
): string | null {
  if (!isGroupMember) return null;
  /* v8 ignore next -- isGroupMember is true only when resolveIsGroupMember saw a non-null conversationId, so the ?? '' fallback is unreachable */
  return conversationId ?? '';
}

/**
 * A non-owner viewer's budgets response carries only their own member row, so
 * the caller's per-member cap is the first (and only) member entry. Absent when
 * the conversation has no member-budget configuration.
 */
function callerMemberRow(
  data: ConversationBudgetsResponse | undefined
): ConversationBudgetsResponse['members'][number] | undefined {
  return data?.members[0];
}

const GUEST_OWNER_MONEY_REFUSALS: ReadonlySet<NoticeReason> = new Set([
  'guest_no_group_budget',
  'group_owner_funds_unavailable',
  'insufficient_funds',
]);

/**
 * Whether a refusal states that the owner's money does not cover this turn —
 * the one class of block that falsifies the delegated-budget notice. The raw
 * code belongs beside the two guest-voiced ones because a media turn is refused
 * by the per-unit producer before {@link guestMoneyRefusal} re-voices anything,
 * so a guest's unaffordable image or video turn carries the raw code.
 */
function isOwnerMoneyRefusal(refusal: NoticeReason | undefined): boolean {
  return refusal !== undefined && GUEST_OWNER_MONEY_REFUSALS.has(refusal);
}

/**
 * Whether an allocation someone else made is what funds THIS sender's turn —
 * the fact the delegated-budget notice states.
 *
 * A signed-in member establishes it from their own member-budget row. A link
 * guest cannot: that read is session-classed and refuses a guest outright
 * (see {@link resolveIsGroupMember}), so the guest arm reads the served funding
 * snapshot, which is the guest's own door and already carries the answer. The
 * owner is a guest's STRUCTURAL payer, so for a guest the served spendable IS
 * the headroom the link was granted, and a positive figure is the whole test:
 * an unallocated link, an exhausted one and an owner with no funds all serve
 * zero, so a separate delegated flag beside it would carry no fact the figure
 * does not already carry.
 *
 * The refusal term keeps the claim off a send the owner's money cannot fund,
 * and off nothing else: the refusal builder tests money before length or
 * admissibility, so a block of any other kind reaching here is itself proof
 * that the allocation covers this turn — which is the state a signed-in member
 * is told who pays in. It is a guest-arm term only: a member's notice reads the
 * budget row alone, exactly as it did before a guest could raise this notice at
 * all.
 */
function resolveHasDelegatedBudget(args: {
  readonly isGroupMember: boolean;
  readonly isLinkGuest: boolean;
  readonly budgets: ConversationBudgetsResponse | undefined;
  readonly payer: 'self' | 'owner';
  readonly payerSpendableNanoUsd: bigint;
  readonly sendRefusal: NoticeReason | undefined;
}): boolean {
  if (args.isLinkGuest) {
    return (
      args.payer === 'owner' &&
      args.payerSpendableNanoUsd > 0n &&
      !isOwnerMoneyRefusal(args.sendRefusal)
    );
  }
  const memberRow = callerMemberRow(args.budgets);
  return args.isGroupMember && memberRow !== undefined && BigInt(memberRow.capNanoUsd) > 0n;
}

/**
 * Project the hook's values onto the input shape `useResolveBilling` expects —
 * a rename, with no branch in it. What it does NOT pass is the load-bearing
 * part, and the reason sits at the return below.
 */
function buildBillingResolverInput(args: {
  estimatedCostNanoUsd: bigint | undefined;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
  conversationId: string | null;
}): {
  estimatedMinimumCostNanoUsd: bigint | undefined;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
  conversationId: string | null;
} {
  const { estimatedCostNanoUsd, isPremiumModel, isAuthenticated, conversationId } = args;
  // The GROUP dimension is deliberately NOT passed. `GET /billing/spendable`
  // already applied §Group Funding 2 server-side and named the payer; feeding a
  // hold-aware group remaining back into the client's funding decision was the
  // same re-resolution removed one layer out, and inside the
  // settle-then-release window it resolved `self` where the server resolves
  // `owner` — telling a member they would be charged for a turn the owner pays,
  // and refusing a link guest a turn admission would admit.
  // The conversation rides along because it NAMES the payer: it is what makes
  // the resolver's funding read the same one every sibling hook already asks
  // for, rather than a second cache entry for one payer's figure.
  return {
    estimatedMinimumCostNanoUsd: estimatedCostNanoUsd,
    isPremiumModel,
    isAuthenticated,
    conversationId,
  };
}

/**
 * The conversation scope the served funding read is keyed by: a solo composer
 * (or a picker opened outside a conversation) asks for its own numbers.
 */
function conversationScope(conversationId: string | null | undefined): string | null {
  return conversationId ?? null;
}

/**
 * A user is a "group member" for billing purposes when they're a non-owner
 * participant in a group conversation. Owners pay from their own balance
 * regardless; only members route through the group budget gate.
 *
 * A link guest is deliberately NOT one, even though it holds a non-owner
 * privilege: the only surface this flag drives is the session-classed budgets
 * read, which refuses a guest outright, and the payer-switch disclosure, which
 * describes a fall-through a guest can never take. Counting a guest here fired
 * a request that 403s and then held the composer in its loading state forever.
 */
function resolveIsGroupMember(
  conversationId: string | null | undefined,
  privilege: MemberPrivilege | undefined,
  isLinkGuest: boolean
): boolean {
  if (isLinkGuest) return false;
  if (conversationId == null) return false;
  if (privilege == null) return false;
  return privilege !== 'owner';
}

interface PromptBudgetDisplayInputs {
  capacityPercent: number;
  /**
   * Whether either read the turn is priced from — the payer's funding or the
   * model catalog — is still outstanding. It arrives as the produced pair's own
   * pending term rather than as a second combination of the same two reads, so
   * the busy affordance and the readiness signal cannot come apart.
   */
  isTurnOptionsPending: boolean;
  currentUsage: number;
  fundingSource: PromptFundingAnswer;
  isGroupMember: boolean;
  isGroupBudgetPending: boolean;
  modelContextLength: number;
  inputValue: string;
  /** The produced pair. `undefined` while its inputs load. */
  turnOptions: TurnOptions | undefined;
  /** Active holds off the same snapshot — the only evidence a hold exists. */
  heldNanoUsd: bigint;
  /** Whether this turn is text; the token verdict governs the text arm only. */
  isTextTurn: boolean;
  /** The media pair, which governs the media arm. */
  mediaOptions: MediaTurnOptions | undefined;
  /** Whether the payer's funding read is exhausted, so no verdict exists at all. */
  isFundingUnavailable: boolean;
  /** Whether the model-catalog read is exhausted, so no turn can be priced at all. */
  isCatalogUnavailable: boolean;
  /**
   * Whether the account's stored-instruction read is still outstanding. The
   * instruction is part of the system prompt {@link promptBasisOf} counts, and
   * an unsettled `null` is not the same turn as an account that stores none.
   */
  isInstructionsReadUnresolved: boolean;
  /** Whether the sender is a link guest, which changes refusal WORDING only. */
  isLinkGuest: boolean;
  /** The payer's served spendable, off the snapshot that produced the pair. */
  payerSpendableNanoUsd: bigint;
}

interface PromptBudgetDisplayResult {
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  /** Whether a block survives the reply in flight. See {@link PromptBudgetResult.hasPersistentBlockingError}. */
  hasPersistentBlockingError: boolean;
  /**
   * Why the send is refused, as a TYPED reason, or `undefined` when it may
   * start. It is the producer's own refusal — NOT an inference from the gap
   * between the two sets, which cannot distinguish a hold from a long prompt
   * because the sets differ in funding AND basis. See {@link sendRefusalOf}.
   */
  sendRefusal: NoticeReason | undefined;
  hasContent: boolean;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
  /** See {@link PromptBudgetResult.isBillingLoading}. */
  isBillingLoading: boolean;
}

/**
 * The turn's prompt basis: COUNTS ONLY, which is what keeps content out of the
 * money layer. Custom instructions are already inside the built system prompt,
 * so they are counted there rather than twice.
 */
function promptBasisOf(systemPrompt: string, historyChars: number, value: string): PromptBasis {
  return {
    systemChars: systemPrompt.length,
    instructionChars: 0,
    historyChars,
    inputChars: value.length,
    attachmentBytes: 0,
  };
}

/**
 * Read-only access refuses every paid action outright, ahead of any money
 * question: no balance and no waiting changes it, so it replaces the funding
 * verdict rather than joining it.
 */
function readOnlyOverride(
  isReadOnly: boolean,
  fundingSource: PromptFundingAnswer,
  sendRefusal: NoticeReason | undefined
): { fundingSource: PromptFundingAnswer; sendRefusal: NoticeReason | undefined } {
  if (!isReadOnly) return { fundingSource, sendRefusal };
  return { fundingSource: 'denied', sendRefusal: 'conversation_read_only' };
}

/**
 * The reason a send is refused, taken from the REFUSAL the producer gave.
 *
 * A hold is claimed ONLY on positive evidence that one exists — `heldNanoUsd`
 * from the same snapshot. The difference between the two option sets cannot
 * establish it: they differ in funding AND prompt basis, so with nothing held
 * `affordable` sends purely because it is evaluated against the EMPTY basis.
 * Reading that gap as a hold told a free user — whose entire daily allowance is
 * 5¢ — to wait for a reply that was not running, on an ordinary long
 * conversation. Waiting never helps there.
 *
 * With nothing held, a funding refusal that the empty basis would have cleared
 * is a LENGTH problem: the funding covers a minimum answer and the prompt is
 * what makes the turn infeasible (§Notices 4 tests the minimum-answer floor
 * first, then attributes to length).
 *
 * Residual, stated rather than hidden: when funds ARE held and the prompt is
 * also long, both causes are live and this names the hold. The hold is the
 * right choice, and the reason is what each notice ASKS THE USER TO DO — not
 * that a hold clears itself, which is only the weaker half.
 *
 * "Wait" costs nothing, is reversible, and becomes true within seconds.
 * "Shorten your message" asks for an irreversible destruction of the user's
 * draft that would NOT unblock the send, because the hold is still there. A
 * false "wait" self-corrects; a false "shorten" leaves the user with less text
 * and the same block. That asymmetry is the whole argument, and it is why a
 * future reader must not reverse this on the grounds that length is "more
 * actionable".
 *
 * What is GUARANTEED, stated exactly: the hold claim is true in every case that
 * reaches it — funds really are held — and it is transient. What is NOT
 * guaranteed is that releasing the hold sends: at a small spendable with a long
 * history, release yields `prompt_too_long` instead. So the notice self-corrects
 * to the length wording rather than to a send. That is still categorically
 * better than the state this replaced, where the claim was false and permanent.
 *
 * Cite §Notices 3 ("waiting is an action"), NOT §Notices 4 — that clause is
 * written about money-versus-length precedence and does not cover
 * hold-versus-length at all.
 */
interface SendRefusalInputs {
  readonly options: TurnOptions | undefined;
  /** The media pair, when the turn is a media one and its inputs have landed. */
  readonly mediaOptions: MediaTurnOptions | undefined;
  readonly heldNanoUsd: bigint;
  /** Whether the payer's funding read is exhausted, so no verdict exists for any modality. */
  readonly isFundingUnavailable: boolean;
  /** Whether the model-catalog read is exhausted, so no modality can be priced at all. */
  readonly isCatalogUnavailable: boolean;
  readonly isTextTurn: boolean;
  /** Whether the sender is a link guest — it changes the money refusal's WORDING, never the verdict. */
  readonly isLinkGuest: boolean;
  /** The payer's served spendable, from the snapshot that produced `options`. */
  readonly payerSpendableNanoUsd: bigint;
}

/**
 * The money refusal a LINK GUEST is shown. A guest holds no wallet, so every
 * copy offering a payment path is a false path (§Notices 3), and the two
 * conditions a guest can actually be in are distinguishable from the served
 * figure alone: nothing was ever allocated to the link (zero), or the owner's
 * funds cannot cover this turn (positive but short). Both actions point at the
 * owner, which is the only person who can unblock the send.
 */
function guestMoneyRefusal(payerSpendableNanoUsd: bigint): NoticeReason {
  return payerSpendableNanoUsd > 0n ? 'group_owner_funds_unavailable' : 'guest_no_group_budget';
}

/**
 * The media arm. The token producer declines to price a non-text modality, so a
 * media turn is gated by the per-unit producer's own `admissible` set — the same
 * verdict the panel greys from, which is what stops a greyed option and a
 * refused send from disagreeing. No verdict yet (a funding or catalog read in
 * flight) refuses nothing: a pending read is not a refusal.
 */
function mediaSendRefusal(mediaOptions: MediaTurnOptions | undefined): NoticeReason | undefined {
  const admissible = mediaOptions?.admissible;
  if (admissible === undefined || admissible.sendable) return undefined;
  return admissible.refusal;
}

function sendRefusalOf(inputs: SendRefusalInputs): NoticeReason | undefined {
  const { options, heldNanoUsd, isTextTurn } = inputs;
  // Ahead of the modality split below, because that split is about which
  // producer prices the turn, and this state has no price of any kind: neither
  // producer can price a turn without the catalog, and neither may price one
  // against funding nobody read, so a media send would otherwise go out on an
  // answer that does not exist.
  //
  // An exhausted read refuses rather than waits, and that is what keeps the busy
  // affordance finite: the loading term stays true while the catalog is absent,
  // however the absence ends, so only a refusal can end the spin.
  if (inputs.isFundingUnavailable || inputs.isCatalogUnavailable) return 'send_check_unavailable';
  if (!isTextTurn) return mediaSendRefusal(inputs.mediaOptions);
  if (options === undefined) return undefined;
  if (options.admissible.sendable) return undefined;
  const refusal = options.admissible.refusal;
  if (refusal !== 'insufficient_funds') return refusal;
  // A guest's money refusal is re-voiced before the hold/length split: both of
  // that split's outcomes are addressed to a wallet holder, and a guest is not
  // one. The verdict is unchanged — only who is asked to act.
  if (inputs.isLinkGuest) return guestMoneyRefusal(inputs.payerSpendableNanoUsd);
  if (!options.affordable.sendable) return refusal;
  return heldNanoUsd > 0n ? 'funds_held_by_run' : 'prompt_too_long';
}

/**
 * Whether a block on the send survives the reply currently in flight.
 *
 * `blockedByVerdict` dominates: while it holds, the answer is persistent
 * whatever the refusal declares. Both its terms are ANSWERS about the turn — the
 * payer's funding door is shut, or the prompt already exceeds the model's
 * context — and no reply finishing changes either, so a block carrying no
 * refusal to read a declaration off is not assumed to end at all.
 *
 * A read still settling is NOT one of them, and the distinction is the point: it
 * is the absence of an answer, it ends on the next read, and nothing the user
 * could do would shorten it. Counting it as persistent closed the queue for the
 * whole load — the window a queue exists for — and it also kept
 * `send_check_unavailable`'s self-clearing declaration from ever reaching the
 * queue, because an exhausted catalog read raises both at once.
 *
 * Where a refusal is the only block, {@link isTransientBlock} decides, and that
 * decision is declared in one place.
 */
function blockPersistsPastTheReply(
  blockedByVerdict: boolean,
  sendRefusal: NoticeReason | undefined
): boolean {
  if (blockedByVerdict) return true;
  return sendRefusal !== undefined && !isTransientBlock(sendRefusal);
}

function computePromptBudgetDisplay(inputs: PromptBudgetDisplayInputs): PromptBudgetDisplayResult {
  const isOverCapacity = isOverContextCapacity(inputs.capacityPercent);
  const isDenied = inputs.fundingSource === 'denied';
  const isBillingLoading =
    inputs.isTurnOptionsPending ||
    (inputs.isGroupMember && inputs.isGroupBudgetPending) ||
    inputs.isInstructionsReadUnresolved;
  const sendRefusal = sendRefusalOf({
    options: inputs.turnOptions,
    mediaOptions: inputs.mediaOptions,
    heldNanoUsd: inputs.heldNanoUsd,
    isFundingUnavailable: inputs.isFundingUnavailable,
    isCatalogUnavailable: inputs.isCatalogUnavailable,
    isTextTurn: inputs.isTextTurn,
    isLinkGuest: inputs.isLinkGuest,
    payerSpendableNanoUsd: inputs.payerSpendableNanoUsd,
  });
  // A load blocks the SEND exactly as a verdict does — nothing may be spent on
  // a figure nobody has read — and the two part company only on whether the
  // block outlasts the reply in flight. See {@link blockPersistsPastTheReply}.
  const blockedByVerdict = isDenied || isOverCapacity;
  const hasBlockingError = blockedByVerdict || isBillingLoading || sendRefusal !== undefined;
  const hasPersistentBlockingError = blockPersistsPastTheReply(blockedByVerdict, sendRefusal);
  const hasContent = inputs.inputValue.trim().length > 0;

  const hasContext = inputs.modelContextLength > 0;
  const capacityCurrentUsage = hasContext ? inputs.currentUsage : 0;
  const capacityMaxCapacity = hasContext ? inputs.modelContextLength : 1;

  return {
    isOverCapacity,
    hasBlockingError,
    hasPersistentBlockingError,
    sendRefusal,
    hasContent,
    capacityCurrentUsage,
    capacityMaxCapacity,
    isBillingLoading,
  };
}

/**
 * The reasoning token budget B the composer's estimate prices, read off the
 * money layer's producer rather than reduced here. Which model's budget sizes a
 * multi-model turn is a money decision, and a surface reducing per-model plans
 * for itself is a second answer to it.
 */
function reasoningBudgetInput(
  selection: ReasoningEffortSelection | undefined,
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly Model[] | undefined
): { reasoningBudgetTokens?: number } {
  const tokens = reasoningBudgetForTurn({
    selection,
    selectedIds: selectedModels.map((selected) => selected.id),
    catalog: modelCatalog,
  });
  return tokens === undefined ? {} : { reasoningBudgetTokens: tokens };
}

/**
 * Restate the client's funding verdict in terms of the payer THE SERVER NAMED.
 *
 * Nothing here decides who pays — `GET /billing/spendable` already applied
 * §Group Funding 2 and returned `payer` alongside the figures. This only picks
 * which sentence describes that answer, which is what §Notices 5 requires:
 * "A change of payer requires an affirmative pre-send disclosure … Switching
 * who pays is not a detail to discover from a balance later."
 *
 * Both disclosures hang off it. An owner-funded turn must not tell a member
 * their own allowance is paying — they are not charged at all — and a member
 * who has fallen through to personal funds must be told so BEFORE sending.
 */
function withServedPayer(
  result: ResolveBillingResult,
  payer: 'self' | 'owner',
  isGroupMember: boolean
): ResolveBillingResult {
  // ORDER IS THE RULE, not an optimisation. When the server says the owner
  // pays, the owner-funded arm is the WHOLE answer, so it must sit ahead of
  // every self-wallet verdict — including the denial early-return below.
  // A patch applied AFTER that return cannot reach the arms that short-circuit
  // into it, which is how the premium lock and the negative-balance block
  // (both statements about the SELF wallet) blocked sends the server admits:
  // §Funding Decision Matrix priority 1 is "Conversation owner pays, premium
  // allowed", and the picker beside the composer already marks those rows
  // available because the served tier is the owner's.
  //
  // The result is replaced rather than spread: a denial carries a `reason`
  // about a wallet that is not paying, and it must not travel with the answer.
  //
  // No verdict survives every arm below it, disclosure included: the served
  // payer arrives on the same snapshot this state does not have, so there is no
  // owner to name and no fall-through to disclose.
  if (result.fundingSource === 'no_verdict') return result;
  if (payer === 'owner') return { fundingSource: 'owner_balance' };
  if (result.fundingSource === 'denied') return result;
  // Self-funding inside a group conversation IS the fall-through §Notices 5
  // exists for; a solo conversation is simply self-funded and discloses nothing.
  if (!isGroupMember) return result;
  return { ...result, payerSwitch: 'group_headroom_insufficient' };
}

/**
 * The payer change carried by a verdict that has one. A denial and an absent
 * verdict carry none by construction — neither describes a charge that will
 * happen — so the union is narrowed here instead of at every reader.
 */
function payerSwitchOf(result: ResolveBillingResult): PayerSwitchReason | undefined {
  if (result.fundingSource === 'no_verdict' || result.fundingSource === 'denied') return undefined;
  return result.payerSwitch;
}

/**
 * The two figures that must not be invented when the turn cannot be priced.
 *
 * The funding estimate becomes an ABSENCE rather than the zero above: that zero
 * is a deliberate "a text turn prices through `admissible`" signal, and reusing
 * it for "there is nothing to price" makes an unpriceable turn read as FUNDED,
 * because any headroom clears a zero minimum. The context window becomes 0
 * rather than `Math.min()` over an empty list, which is `Infinity` and rendered
 * the capacity meter against an unbounded window.
 */
function unpriceableAwareInputs(
  selectedRows: readonly Model[] | undefined,
  estimatedCostNanoUsd: bigint | undefined
): { modelContextLength: number; fundingEstimateNanoUsd: bigint | undefined } {
  if (selectedRows === undefined || estimatedCostNanoUsd === undefined) {
    return {
      modelContextLength:
        selectedRows === undefined ? 0 : Math.min(...selectedRows.map((row) => row.contextLength)),
      fundingEstimateNanoUsd: undefined,
    };
  }
  return {
    modelContextLength: Math.min(...selectedRows.map((row) => row.contextLength)),
    fundingEstimateNanoUsd: estimatedCostNanoUsd,
  };
}

/**
 * Read-only access joins BOTH block terms, and the second is why this is stated
 * rather than assumed: no reply finishing hands the privilege back, so it is the
 * one block that outlasts everything the composer can wait for.
 */
function readOnlyBlocks(
  display: PromptBudgetDisplayResult,
  isReadOnly: boolean
): Pick<PromptBudgetResult, 'hasBlockingError' | 'hasPersistentBlockingError'> {
  return {
    hasBlockingError: display.hasBlockingError || isReadOnly,
    hasPersistentBlockingError: display.hasPersistentBlockingError || isReadOnly,
  };
}

/**
 * The answer share the notices read. The shortened-reply warning says the
 * balance may cut a text reply short, and a media turn produces no text, so
 * that claim is false for it whatever the balance or the web-search setting:
 * its share is unbounded and the warning never fires on it.
 */
function answerShareForNotices(modality: ChatModality, maxAnswerTokens: number): number {
  return modality === 'text' ? maxAnswerTokens : Number.POSITIVE_INFINITY;
}

/**
 * The rung the producer took its hold at, read off its own set: the loop a
 * searching preview prices is that one, never one derived a second time here.
 */
function loopEffortInput(options: TurnOptions | undefined): {
  loopEffort?: ResolvedReasoningEffort;
} {
  const effort = options?.admissible.holdEffort;
  return effort === undefined ? {} : { loopEffort: effort };
}

export function usePromptBudget(input: PromptBudgetInput): PromptBudgetResult {
  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  // imageConfig has aspect ratio only — image cost is per-image regardless of
  // ratio, so no need to read it here. Video and audio configs DO drive cost
  // (resolution and duration are billed).
  const videoConfig = useModelStore((state) => state.videoConfig);
  const audioConfig = useModelStore((state) => state.audioConfig);
  const { active: webSearchActive } = useWebSearch();
  // `isError` is the catalog read's EXHAUSTED arm — the retry policy has already
  // run by the time it is set. The query publishes no `data` for an in-flight
  // read or a failed one alike, so this flag is the only thing that separates a
  // catalog still coming from one that never will.
  const { data: modelsData, isError: isCatalogUnavailable } = useModels();
  const { data: session, isPending: isSessionPending } = useSession();

  const catalog = modelsData?.models;
  const selectedRows = selectedServedRows(selectedModels, catalog);
  const isAuthenticated = !isSessionPending && Boolean(session?.user);
  const customInstructions = useAuthStore((s) => s.customInstructions);
  const isInstructionsReadUnresolved = useAuthStore(selectInstructionsReadUnresolved);
  // The SENDER's tier. It answers who is sending — never what funds the turn,
  // which the served snapshot's `payerTier` answers (BILLING §User Tiers).
  const isLinkGuest = useUserTierInfo(isAuthenticated).tier === 'guest';
  const isGroupMember = resolveIsGroupMember(
    input.conversationId,
    input.currentUserPrivilege,
    isLinkGuest
  );

  const { data: groupBudgetData, isPending: isGroupBudgetPending } = useConversationBudgets(
    resolveGroupBudgetArgument(isGroupMember, input.conversationId)
  );

  // The send-path builder is the truth: the preview measures the exact system
  // prompt the language adapter sends (base preamble + custom instructions —
  // never capability blocks), through the ONE shared counter. The builder's
  // date line is fixed-width, so the count is stable across renders.
  // That identity holds only while the send path also puts these instructions
  // on the wire — the server has no other way to obtain them (they are stored
  // E2E-encrypted), so a turn body that drops them makes this preview count a
  // prompt the server never builds.
  const systemPrompt = React.useMemo(
    () =>
      buildTurnSystemPrompt({
        utcDay: utcDayKey(new Date()),
        ...(customInstructions == null ? {} : { customInstructions }),
      }),
    [customInstructions]
  );
  const promptChars = promptCharacterCount({
    systemPrompt,
    historyCharacters: input.historyCharacters,
    prompt: input.value,
  });

  // The send gate's own source. `admissible` is evaluated against the COMPOSED
  // basis and the hold-aware figure — the question "can this turn start right
  // now" — while the picker's `affordable` is neither. One call yields both.
  // ONE basis object for both producers: they must price the same turn, and a
  // fresh identity per render would also re-run each producer's memo every keystroke.
  const basis = React.useMemo(
    () => promptBasisOf(systemPrompt, input.historyCharacters, input.value),
    [systemPrompt, input.historyCharacters, input.value]
  );
  // The pin comes from the effort producer, not from `input.reasoningEffort`:
  // every live instance of this hook must grade against the SAME pin, and only
  // the composer's caller supplies one.
  const { effective: effortPin } = useReasoningEffort();
  const turnOptions = useTurnOptions({
    basis,
    isAuthenticated,
    conversationId: conversationScope(input.conversationId),
    ...(effortPin !== undefined && { effort: effortPin }),
  });

  // 1. Math-only budget calculation. Web search is authenticated-only; the core
  // adds its own worst-case reservation line item when enabled (never a mirrored
  // client cost), matching the server reservation.
  const budgetResult = useBudgetCalculation({
    promptCharacterCount: promptChars,
    // The message being composed is the storage basis: the same component
    // `promptBasisOf` hands the send gate, so the preview and the gate price one
    // turn.
    inputCharacterCount: input.value.length,
    models: selectedRows,
    turnOptions: turnOptions.options,
    isAuthenticated,
    // The conversation names the payer whose funds and tier size the turn.
    conversationId: conversationScope(input.conversationId),
    ...(webSearchActive && { webSearch: true }),
    ...loopEffortInput(turnOptions.options),
    ...reasoningBudgetInput(input.reasoningEffort, selectedModels, catalog),
  });
  // The per-unit pair for a media turn. The basis is the composer's real one:
  // the producer substitutes the empty basis for the `affordable` set itself, so
  // passing one here would drop the input-storage leg from the send gate.
  const mediaTurnOptions = useMediaTurnOptions({
    basis,
    isAuthenticated,
    conversationId: conversationScope(input.conversationId),
  });

  // Media cost — image and video only; audio is not a priced modality. It asks
  // the same producer the backend's reservation agrees with, so the displayed
  // estimate matches what the server-side balance gate compares against. A text
  // turn contributes no money estimate at all; there is no token-based fallback
  // to fall through to.
  const mediaCostNanoUsd = useMediaCostEstimate({
    modality: activeModality,
    models: selectedRows,
    videoResolution: videoConfig.resolution,
    durationSeconds:
      activeModality === 'audio' ? audioConfig.maxDurationSeconds : videoConfig.durationSeconds,
  });

  // 3. Resolve billing: who pays or why denied
  const isPremiumModel = selectedModels.some((sm) => modelsData?.premiumIds.has(sm.id) ?? false);
  // A TEXT turn contributes no money estimate to the funding decision:
  // `admissible` is its whole money verdict. Only a per-unit media generation
  // still needs one, and it keeps its own path.
  // A media turn with no per-unit price has no funding question to ask; a TEXT
  // turn's `0n` is not an absence but a deliberate "this arm prices through
  // `admissible`" signal, so the two must not be spelled the same way.
  const estimatedCostNanoUsd = activeModality === 'text' ? 0n : mediaCostNanoUsd;
  const { modelContextLength, fundingEstimateNanoUsd } = unpriceableAwareInputs(
    selectedRows,
    estimatedCostNanoUsd
  );

  const selfFundedResult = useResolveBilling(
    buildBillingResolverInput({
      estimatedCostNanoUsd: fundingEstimateNanoUsd,
      isPremiumModel,
      isAuthenticated,
      conversationId: conversationScope(input.conversationId),
    })
  );
  const billingResult = withServedPayer(selfFundedResult, turnOptions.payer, isGroupMember);

  // 4. Derive display values
  const display = computePromptBudgetDisplay({
    capacityPercent: budgetResult.capacityPercent,
    // Both unsettled states block the send: nothing may be spent on a turn no
    // price exists for, whether the read is still coming or never will. The
    // pending half is the pair's own term, and the exhausted half reaches the
    // refusal below, so a surface that owes the user different words for the two
    // has them without re-deriving either.
    isTurnOptionsPending: turnOptions.isPending,
    currentUsage: budgetResult.currentUsage,
    fundingSource: billingResult.fundingSource,
    isGroupMember,
    isGroupBudgetPending,
    modelContextLength,
    inputValue: input.value,
    turnOptions: turnOptions.options,
    heldNanoUsd: turnOptions.heldNanoUsd,
    isTextTurn: activeModality === 'text',
    mediaOptions: mediaTurnOptions.options,
    isFundingUnavailable: turnOptions.isFundingUnavailable,
    isCatalogUnavailable,
    isInstructionsReadUnresolved,
    isLinkGuest,
    payerSpendableNanoUsd: turnOptions.payerSpendableNanoUsd,
  });

  // 5. Generate notifications
  const hasDelegatedBudget = resolveHasDelegatedBudget({
    isGroupMember,
    isLinkGuest,
    budgets: groupBudgetData,
    payer: turnOptions.payer,
    payerSpendableNanoUsd: turnOptions.payerSpendableNanoUsd,
    sendRefusal: display.sendRefusal,
  });
  const notifications = React.useMemo(
    () =>
      // Every notice here is derived from a funding verdict, and an absent
      // funding read leaves none to derive one from — whether the read is still
      // in flight or exhausted. Deciding it here is why `generateNotifications`
      // takes a verdict and cannot be handed this state at all.
      billingResult.fundingSource === 'no_verdict'
        ? []
        : generateNotifications({
            billingResult,
            capacityPercent: budgetResult.capacityPercent,
            maxAnswerTokens: answerShareForNotices(activeModality, budgetResult.maxAnswerTokens),
            ...(input.currentUserPrivilege !== undefined && {
              privilege: input.currentUserPrivilege,
            }),
            ...(hasDelegatedBudget && { hasDelegatedBudget: true }),
          }),
    [
      billingResult,
      budgetResult.capacityPercent,
      budgetResult.maxAnswerTokens,
      activeModality,
      input.currentUserPrivilege,
      hasDelegatedBudget,
    ]
  );

  const effortDimension = turnOptions.options?.affordable.turnDimensions.find(
    (dimension) => dimension.dimensionId === 'effort'
  );

  const isReadOnly = input.currentUserPrivilege === 'read';
  const gated = readOnlyOverride(isReadOnly, billingResult.fundingSource, display.sendRefusal);
  const blocked = readOnlyBlocks(display, isReadOnly);
  const composerNotices = React.useMemo(
    () => composeComposerNotices({ refusal: gated.sendRefusal, verdictNotices: notifications }),
    [gated.sendRefusal, notifications]
  );

  return {
    fundingSource: gated.fundingSource,
    notifications,
    notices: composerNotices,
    payerSwitch: payerSwitchOf(billingResult),
    capacityPercent: budgetResult.capacityPercent,
    capacityBand: contextFillBand(budgetResult.capacityPercent),
    capacityCurrentUsage: display.capacityCurrentUsage,
    capacityMaxCapacity: display.capacityMaxCapacity,
    estimatedCostNanoUsd: fundingEstimateNanoUsd,
    isOverCapacity: display.isOverCapacity,
    ...blocked,
    sendRefusal: gated.sendRefusal,
    isBillingLoading: display.isBillingLoading,
    isAffordabilitySettled: !turnOptions.isPending,
    hasContent: display.hasContent,
    maxOutputTokens: budgetResult.maxOutputTokens,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
    mediaOptions: mediaTurnOptions.options,
    effortDimension,
  };
}
