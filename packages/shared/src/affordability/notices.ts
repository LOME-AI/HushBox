/**
 * The one home for money copy (`docs/BILLING.md` §Notices & Refusals).
 *
 * Every unavailable option and every blocked send carries a machine-readable
 * reason, and this table is the reason→sentence map. The pre-send notice and
 * the wire refusal for one condition are the same string because both resolve
 * through here; `error-codes.test.ts` pins that derivation for every wire code
 * that shares a condition with this vocabulary, so a re-typed sentence at the
 * wire end fails a test rather than passing a review.
 *
 * Three properties this module guarantees, by shape rather than by review:
 *
 * - **An action is required.** An entry is a cause plus a non-empty action
 *   clause, so an entry that names a cause and leaves the user to guess which
 *   input to change does not typecheck.
 * - **Severity has one declaration.** An entry declares only whether the
 *   condition blocks; the rendered `type` is computed from it, so a dismissible
 *   error is unrepresentable here. What a surface does with `type` is that
 *   surface's own rule, pinned by that surface's tests.
 * - **Magnitudes are absent.** No sentence here names an amount, a token count
 *   or a threshold; the enumeration test in this directory asserts it over
 *   every wording, so a new entry inherits the rule instead of being trusted
 *   with it.
 */

import { ROUTES } from '../platform/routes.ts';
import { REFUSAL_CODES } from './turn/turn-types.ts';
import type { AddAvailability, Availability, SelectionCausedReason } from './turn/turn-types.ts';

/**
 * A refused row's verdict as the turn arithmetic published it: the reason, and —
 * on the arm that grades adding a row to the selection — whose problem the
 * refusal is.
 *
 * Spelled as a narrowing of the published verdict types rather than as its own
 * shape, so a surface hands its verdict straight back and nothing here can
 * disagree with what the producer said.
 */
type RefusedVerdict = Extract<Availability | AddAvailability, { available: false }>;

/** A segment of a rendered message, optionally carrying an in-app destination. */
export interface MessageSegment {
  /** The text content of this segment */
  text: string;
  /** Route path if this segment should be a clickable link */
  link?: string;
}

export interface BudgetError {
  /** The typed reason this notice was produced from, or the trial count's id. */
  id: ComposerNoticeId;
  /** Severity: 'error' blocks send, 'warning' allows, 'info' is informational */
  type: 'warning' | 'error' | 'info';
  /** Human-readable message to display (plain text fallback) */
  message: string;
  /** Structured message with optional links for rendering */
  segments?: MessageSegment[];
  /** What ends the block, as the reason declares it; present only on a blocking notice. */
  blockClears?: BlockClears;
}

/**
 * Every condition the money vocabulary explains. The refusal codes the turn
 * arithmetic produces are spread in whole — a reason that can grey an option
 * must be explainable — and the turn-level conditions the arithmetic cannot see
 * follow.
 *
 * Two reasons are deliberately kept apart wherever their ACTIONS differ, since
 * an action the user cannot take is worse than no action: premium splits on
 * whether an account exists, and held funds split from an empty balance because
 * paying fixes one and only waiting fixes the other.
 */
export const NOTICE_REASONS = [
  ...REFUSAL_CODES,
  /**
   * The payer's own purchased balance is below zero. Kept apart from
   * `insufficient_funds`, which also words a shortfall at a positive balance,
   * where "below zero" would be false.
   */
  'balance_negative',
  /** The free daily allowance cannot cover this message; credit or tomorrow can. */
  'free_allowance_exhausted',
  /** A link guest with no allocation — no wallet of their own exists to fall back on. */
  'guest_no_group_budget',
  /** An owner-funded turn the owner's wallet can no longer cover. */
  'group_owner_funds_unavailable',
  /** The payer's funds are reserved by a run in flight, not spent. */
  'funds_held_by_run',
  /**
   * A read this turn had to be priced from could not be completed, so no verdict
   * about the turn exists. It is the absence of an answer rather than a refusing
   * one, and three exhausted reads reach the user through it: the client's
   * funding read, the client's model-catalog read — without which no turn can be
   * priced at all — and the server's own fail-closed admission when it cannot
   * reach the state the gate compares against.
   */
  'send_check_unavailable',
  /** This conversation is already generating; one run per conversation is hard-blocked. */
  'run_already_in_progress',
  /** The sender has read access only, so no paid action is available at all. */
  'conversation_read_only',
  /**
   * A paid send was refused without one nameable condition. Two producers reach
   * it: the admission balance gate (spendable funds minus funds reserved by runs
   * in flight), and the Smart Model build finding no candidate the payer's
   * effective funding can cover. Neither can say which of pay, wait, or budget
   * is the remedy, so this copy names none of them and offers all three.
   */
  'send_cannot_start',
  /** The turn will be charged to the sender rather than to the conversation owner. */
  'payer_switched_to_personal',
  /** The conversation owner's budget is covering this sender's messages. */
  'group_budget_pays',
  /** The free daily allowance is covering this message. */
  'free_allowance_pays',
  /** The trial's fixed per-message ceiling is covering this message. */
  'trial_preview_pays',
  /** The prompt is close enough to the model's context that replies may be cut short. */
  'context_near_capacity',
  /** Funds remain, but not enough to buy a full-length reply. */
  'answer_may_be_shortened',
] as const;

export type NoticeReason = (typeof NOTICE_REASONS)[number];

/**
 * The composer element that states how many free-preview messages are left.
 * It rides the notice stack and takes its test ids the way every notice there
 * does, but it is not a notice: the vocabulary's sentences are magnitude-free
 * and a count is a magnitude, so no {@link NoticeReason} names it.
 */
export const TRIAL_REMAINING_MESSAGE_ID = 'trial_messages_remaining';

/** What an element of the composer's notice stack is identified by. */
export type ComposerNoticeId = NoticeReason | typeof TRIAL_REMAINING_MESSAGE_ID;

/**
 * Whether the condition blocks the send, and — when it does — what ends the
 * block. Everything else about severity is derived from it, so a dismissible
 * error is unrepresentable; `tone` exists only on the arm where a choice
 * remains, and `clears` only on the arm where there is a block to end.
 *
 * `clears` is mandatory rather than optional so the classification cannot be
 * skipped: a reason added without it does not compile. That is the whole
 * mechanism — every surface that DEFERS an action past a block instead of
 * refusing it reads the declaration, so a list of codes maintained beside the
 * vocabulary would answer for today's members and stay silent about the next
 * one, defaulting it into whichever half the reader happens to assume.
 */
type NoticeSeverity =
  | { readonly blocking: true; readonly clears: 'on_its_own' | 'when_the_user_acts' }
  | { readonly blocking: false; readonly tone: 'warning' | 'info' };

/** What ends a block, read off the one declaration in {@link NoticeSeverity}. */
type BlockClears = Extract<NoticeSeverity, { blocking: true }>['clears'];

export interface NoticeCopy {
  /** What happened, in the user's terms. Never a magnitude, never an internal bound. */
  readonly cause: string;
  /**
   * What the user can do about it. Non-empty by type: the first segment
   * continues the sentence the cause opened, and a linked segment names an
   * in-app destination. Waiting is an action; an absent action is not.
   */
  readonly action: readonly [MessageSegment, ...MessageSegment[]];
  readonly severity: NoticeSeverity;
}

const BLOCKING: NoticeSeverity = { blocking: true, clears: 'when_the_user_acts' };
/** A block the user cannot shorten and does not have to: it ends when the condition it names ends. */
const BLOCKING_UNTIL_IT_PASSES: NoticeSeverity = { blocking: true, clears: 'on_its_own' };
const INFO: NoticeSeverity = { blocking: false, tone: 'info' };
const WARNING: NoticeSeverity = { blocking: false, tone: 'warning' };

/**
 * One entry per reason. This object is the whole vocabulary: adding a condition
 * is adding a row, and every surface that renders availability picks it up
 * without change because reasons travel with options.
 */
export const NOTICE_COPY: Readonly<Record<NoticeReason, NoticeCopy>> = {
  premium_requires_account: {
    cause: 'This model needs an account.',
    action: [{ text: 'Sign up', link: ROUTES.SIGNUP }, { text: ' to chat with premium models.' }],
    severity: BLOCKING,
  },
  premium_requires_credit: {
    cause: 'Premium models need a paid balance.',
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ' to unlock them.' }],
    severity: BLOCKING,
  },
  trial_message_cap_exceeded: {
    cause: 'This message is too costly for the free trial.',
    action: [
      { text: 'Shorten it, or ' },
      { text: 'sign up', link: ROUTES.SIGNUP },
      { text: ' to keep chatting.' },
    ],
    severity: BLOCKING,
  },
  insufficient_funds: {
    cause: "Your balance can't cover this message.",
    action: [
      { text: 'Add credit', link: ROUTES.BILLING },
      { text: ', or choose a more affordable model.' },
    ],
    severity: BLOCKING,
  },
  balance_negative: {
    cause: 'Your balance is below zero.',
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ' to send messages again.' }],
    severity: BLOCKING,
  },
  prompt_too_long: {
    cause: 'This conversation is too long for this model.',
    action: [
      {
        text: 'Shorten your message, start a new conversation, or choose a model that reads more.',
      },
    ],
    severity: BLOCKING,
  },
  model_output_cap_too_low: {
    cause: "This model can't write a long enough answer.",
    action: [{ text: 'Choose a different model.' }],
    severity: BLOCKING,
  },
  option_not_offered: {
    cause: "This model doesn't offer that setting.",
    action: [{ text: 'Choose a different setting, or a different model.' }],
    severity: BLOCKING,
  },
  model_not_priceable: {
    cause: "This model isn't available right now.",
    action: [{ text: 'Choose a different model.' }],
    severity: BLOCKING,
  },
  modality_not_priceable: {
    cause: "This kind of content can't be sent right now.",
    action: [{ text: 'Choose a different content type, or a different model.' }],
    severity: BLOCKING,
  },
  free_allowance_exhausted: {
    cause: "Your free daily allowance can't cover this message.",
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ', or come back tomorrow.' }],
    severity: BLOCKING,
  },
  guest_no_group_budget: {
    // A guest holds no wallet of their own, so a payment path here would be a
    // false path: only the owner can make this send possible.
    cause: 'You have no budget in this conversation.',
    action: [{ text: 'Ask the conversation owner to allocate some.' }],
    severity: BLOCKING,
  },
  group_owner_funds_unavailable: {
    // Names the cause without disclosing what the owner's wallet is doing: the
    // served owner figure is hold-blind for privacy, and the sender is not
    // entitled to infer the owner's activity from a refusal.
    cause: "The conversation owner's budget can't cover this message.",
    action: [{ text: 'Ask the conversation owner for budget, or try again shortly.' }],
    severity: BLOCKING,
  },
  funds_held_by_run: {
    // Reserved funds return when the run finishes, so paying would not help and
    // offering it would be a false path. The conversation holding the reservation
    // is deliberately unnamed.
    cause: 'Another reply is still holding your funds.',
    action: [{ text: 'Wait for it to finish, then send again.' }],
    severity: BLOCKING_UNTIL_IT_PASSES,
  },
  send_check_unavailable: {
    // Neither half of the sentence may name what failed: which read or which
    // store was unreachable is an internal constraint (§Notices 6), and no
    // payment or shortening action can move it. Retrying is the whole remedy,
    // and it is an action (§Notices 3) — waiting with nothing said is not.
    cause: "We couldn't check whether this message can be sent.",
    action: [{ text: 'Please try again shortly.' }],
    severity: BLOCKING_UNTIL_IT_PASSES,
  },
  run_already_in_progress: {
    cause: 'This conversation is already generating a reply.',
    action: [{ text: 'Wait for it to finish, then send again.' }],
    severity: BLOCKING_UNTIL_IT_PASSES,
  },
  conversation_read_only: {
    cause: 'You have read-only access to this conversation.',
    action: [{ text: 'Ask the conversation owner for permission to send.' }],
    severity: BLOCKING,
  },
  send_cannot_start: {
    // Every clause has to be true of BOTH producers, which is why none of them
    // can be dropped: the admission balance gate compares spendable funds minus
    // funds reserved by runs in flight, and the Smart Model build refuses when no
    // candidate fits the payer's effective funding — the owner's headroom for a
    // group turn, the remaining daily allowance for a free-tier sender. Naming
    // the balance alone tells a payer with ample funds to pay; dropping budgets
    // leaves a group sender with no true remedy.
    cause: "This message can't be sent right now.",
    action: [
      {
        text: 'Check your balance and budgets, or wait for your other replies to finish, then try again.',
      },
    ],
    severity: BLOCKING,
  },
  payer_switched_to_personal: {
    cause: 'This message will be charged to your own balance.',
    action: [{ text: 'Ask the conversation owner for budget to change that.' }],
    severity: INFO,
  },
  group_budget_pays: {
    // An informational notice rides alongside whatever blocking notice the
    // precedence picked, so its action stays verdict-neutral: telling the user
    // to send would invite exactly the action a disabled composer refuses.
    cause: "The conversation owner's budget covers your messages, so you won't be charged.",
    action: [{ text: 'Ask them for more if it runs out.' }],
    severity: INFO,
  },
  free_allowance_pays: {
    // The offer is about how many messages the day holds, never about how much
    // one message may contain: this renders beside a length refusal, and money
    // does not move a context bound.
    cause: 'This message uses your free daily allowance.',
    action: [
      { text: 'Add credit', link: ROUTES.BILLING },
      { text: ' for more messages each day.' },
    ],
    severity: INFO,
  },
  trial_preview_pays: {
    cause: 'You are chatting in the free preview.',
    action: [{ text: 'Sign up', link: ROUTES.SIGNUP }, { text: ' for full access.' }],
    severity: INFO,
  },
  context_near_capacity: {
    cause: 'This conversation is getting long for this model, so replies may be cut short.',
    action: [{ text: 'Start a new conversation to keep full-length replies.' }],
    severity: WARNING,
  },
  answer_may_be_shortened: {
    cause: 'Your balance is running low, so replies may be shortened.',
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ' for longer replies.' }],
    severity: WARNING,
  },
};

/**
 * The same conditions, worded for a row that is blocked by a MODEL THE PAYER HAS
 * ALREADY SELECTED rather than by anything about itself.
 *
 * A variant of the real reason, never a replacement for it: the cause is still
 * the true condition and the action still offers the true remedy, with removal
 * added. Telling the user only to remove something would hide the balance or the
 * length that actually bound.
 *
 * Every action clause here stands alone, and that is a constraint rather than a
 * style. A picker row renders the ACTION segments only — the cause reaches it as
 * screen-reader text — so a pronoun whose antecedent lives in the cause would
 * resolve, for a sighted user, to the row they are looking at, which is the one
 * model the sentence is not about.
 *
 * Keyed by {@link SelectionCausedReason}, so the map is exhaustive by typecheck:
 * a reason a sibling can newly impose does not compile without a wording.
 */
export const SELECTION_CAUSED_COPY: Readonly<Record<SelectionCausedReason, NoticeCopy>> = {
  premium_requires_account: {
    cause: "A model you've selected needs an account.",
    action: [
      { text: 'Sign up', link: ROUTES.SIGNUP },
      { text: ' to chat with premium models, or remove the selected model.' },
    ],
    severity: BLOCKING,
  },
  premium_requires_credit: {
    cause: "A model you've selected needs a paid balance.",
    action: [
      { text: 'Add credit', link: ROUTES.BILLING },
      { text: ', or remove the selected model.' },
    ],
    severity: BLOCKING,
  },
  trial_message_cap_exceeded: {
    cause: 'This message is too costly for the free trial.',
    action: [
      { text: 'Shorten your message, remove a selected model, or ' },
      { text: 'sign up', link: ROUTES.SIGNUP },
      { text: ' to keep chatting.' },
    ],
    severity: BLOCKING,
  },
  insufficient_funds: {
    cause: "Your balance can't cover this message.",
    action: [
      { text: 'Add credit', link: ROUTES.BILLING },
      { text: ', or remove a selected model.' },
    ],
    severity: BLOCKING,
  },
  prompt_too_long: {
    cause: "This conversation is too long for a model you've selected.",
    action: [
      {
        text: 'Remove the selected model, shorten your message, or start a new conversation.',
      },
    ],
    severity: BLOCKING,
  },
  model_output_cap_too_low: {
    cause: "A model you've selected can't write a long enough answer.",
    action: [{ text: 'Remove the selected model, or choose a different one.' }],
    severity: BLOCKING,
  },
};

/**
 * A notice produced from the vocabulary. It narrows {@link BudgetError} on both
 * fields a derived notice always has: its identity is the typed reason, and its
 * segments are present, because copy here is always a cause plus an action.
 */
export interface Notice extends BudgetError {
  id: NoticeReason;
  segments: MessageSegment[];
  /**
   * The action clause alone — what the user can do — with its destinations
   * intact.
   *
   * Present beside {@link BudgetError.segments} because the two are different
   * channels rather than two spellings of one: the composer renders the whole
   * notice, while a picker row shows only this clause and sends `message` to a
   * screen reader. Handing back both is what keeps a surface from taking the
   * sentence apart to get at half of it.
   */
  action: readonly [MessageSegment, ...MessageSegment[]];
}

/**
 * The rendered sentence for a copy: its cause, then its action clause.
 *
 * Takes the copy rather than the reason because {@link SELECTION_CAUSED_COPY} is
 * keyed by the same reasons {@link NOTICE_COPY} is, so no argument to
 * {@link noticeText} can reach a variant wording. Which of the two a refusal is
 * read from is {@link copyFor}'s answer and is settled inside this module, off
 * the attribution the producer published; a surface renders {@link notices} and
 * composes no sentence of its own.
 */
export function noticeTextOf(copy: NoticeCopy): string {
  return `${copy.cause} ${copy.action.map((segment) => segment.text).join('')}`;
}

/** The rendered sentence for a reason, from the ordinary vocabulary. */
export function noticeText(reason: NoticeReason): string {
  return noticeTextOf(NOTICE_COPY[reason]);
}

/**
 * Whether this reason blocks the send AND ends without the user doing anything.
 *
 * The one place any surface may ask that question. Both readers defer an action
 * past the block rather than refusing it — the composer keeps the queue button
 * live, and the drain waits on the queued message instead of dumping it back —
 * so a second list would let a queue accept a message the drain then refuses.
 * The answer is read off {@link NOTICE_COPY}, never off a set of codes: that is
 * what makes a reason added tomorrow arrive already classified.
 *
 * A non-blocking reason answers false. There is no block to wait out, so
 * "transient" is not a property it can have.
 */
export function isTransientBlock(reason: NoticeReason): boolean {
  const { severity } = NOTICE_COPY[reason];
  return severity.blocking && severity.clears === 'on_its_own';
}

/**
 * The refusals a regenerate is exempt from: entitlement to the model, which was
 * settled when the turn that first chose it was admitted. Re-asking would strand
 * a payer on a reply the platform has already served them.
 *
 * NOT CLOSED against the server: the API grants the same exemption by SKIPPING
 * the premium check for a regenerate whose premise it has verified — a gate mode
 * on the turn route, not a reason set — so it does not read this list and the two
 * can drift. What holds them together today is that both sides refuse everything
 * except entitlement; a third entitlement refusal added on one side would have to
 * be added to the other by hand.
 *
 * Enumerated here rather than off {@link NOTICE_COPY} because no declared
 * property separates these two from the money refusals that share their remedy:
 * `insufficient_funds` also sends the user to billing, and exempting it would
 * hand out a free re-run.
 */
const REGENERATE_EXEMPT_REASONS: ReadonlySet<NoticeReason> = new Set<NoticeReason>([
  'premium_requires_account',
  'premium_requires_credit',
]);

/**
 * Whether this send refusal still refuses a RE-RUN of a model the turn already
 * used. A re-run is a paid turn like any other, so every money reason — an
 * empty balance, funds held by a run in flight, a trial ceiling, a funding read
 * that failed — applies to it exactly as it applies to a send.
 *
 * The one place any surface may ask that question, and it answers CLOSED: a
 * reason outside {@link REGENERATE_EXEMPT_REASONS} refuses, so a condition added
 * tomorrow arrives refusing a re-run rather than silently exempt from one.
 */
export function refusesRegenerate(reason: NoticeReason): boolean {
  return !REGENERATE_EXEMPT_REASONS.has(reason);
}

/**
 * The wording a refusal is explained by: the variant only where the producer
 * MARKED the refusal as the selection's doing, and the ordinary vocabulary for
 * every other input — a bare reason, and a verdict attributed to the model or
 * carrying no attribution at all.
 *
 * The attribution is read, never derived. Both maps are keyed by the same
 * reasons, so nothing about a reason alone can distinguish them, and a surface
 * inferring the attribution for itself would be a second grading rule beside
 * the one the producer already published.
 */
function copyFor(refusal: NoticeReason | RefusedVerdict): NoticeCopy {
  if (typeof refusal === 'string') return NOTICE_COPY[refusal];
  return 'causedBy' in refusal && refusal.causedBy === 'selection'
    ? SELECTION_CAUSED_COPY[refusal.reason]
    : NOTICE_COPY[refusal.reason];
}

/**
 * The renderable notice for a reason, or for a refused row's whole verdict.
 * `type` is computed from the declared blocking flag rather than declared
 * beside it, so no entry can carry a severity that disagrees with whether it
 * blocks.
 */
export function notices(refusal: NoticeReason | RefusedVerdict): Notice {
  const copy = copyFor(refusal);
  return {
    id: typeof refusal === 'string' ? refusal : refusal.reason,
    type: copy.severity.blocking ? 'error' : copy.severity.tone,
    message: noticeTextOf(copy),
    action: copy.action,
    segments: [{ text: `${copy.cause} ` }, ...copy.action],
    ...(copy.severity.blocking && { blockClears: copy.severity.clears }),
  };
}
