import type { FundingSource } from '@hushbox/shared';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';

interface SubmitState {
  hasContent: boolean;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  disabled: boolean;
  isProcessing: boolean;
}

/**
 * The verdict for a send that SPENDS, once. Queueing a message only defers the
 * send that spends on it, so the queue affordance and the send button must not
 * be able to disagree: both read this, and each adds only the run-state
 * condition that distinguishes them (send needs an idle run, queue needs a live
 * one).
 *
 * A send that spends nothing is a different question, answered by
 * {@link canSubmitUserOnlyMessage}, and the two are separate functions so that
 * neither can be collapsed into the other: the funding block asked about here
 * would refuse a free post the API accepts.
 *
 * They differ in one input, and only because deferring changes WHEN the block is
 * asked about: the send is asked now and reads every block, the queue is asked
 * about a send that happens after the reply in flight ends. Which blocks reach
 * that later send is not decided here — the budget hook answers it, and answers
 * conservatively: only a refusal declared to end on its own is dropped, so a
 * block that will in fact have cleared by then can still hold the queue.
 */
export function isSendable(state: Omit<SubmitState, 'isProcessing'>): boolean {
  if (!state.hasContent) return false;
  if (state.isOverCapacity) return false;
  if (state.hasBlockingError) return false;
  if (state.disabled) return false;
  return true;
}

interface PaidSubmitState extends SubmitState {
  /**
   * Whether the funding read has produced a wallet this send may be spent on.
   * It is asked here and nowhere below: {@link isSendable} answers for the
   * queue too, and a deferred send waits on no funding read.
   *
   * The blocking flags do not stand in for it. They and the funding answer are
   * separate fields of one budget result, and a turn the catalog carries no
   * price for publishes an absent answer while raising none of them — a control
   * gated on the flags alone is live there and swallows the press.
   */
  hasSpendableFunding: boolean;
}

function canSubmitMessage(state: PaidSubmitState): boolean {
  if (state.isProcessing) return false;
  if (!state.hasSpendableFunding) return false;
  return isSendable(state);
}

interface UserOnlySubmitState {
  hasContent: boolean;
  isReadOnly: boolean;
  disabled: boolean;
  isProcessing: boolean;
}

/**
 * The verdict for the send that spends NOTHING: the AI-off post in a group,
 * which reaches the API's user-only message route. That route authorizes on
 * membership and write privilege and performs no balance check, so a funding
 * block does not belong here — asking it refuses a member with an empty wallet
 * a post that costs nothing. The context-capacity bound does not belong here
 * either: it measures a prompt against a model window this send never fills.
 * Read privilege is the one refusal it keeps, the server refusing that post too.
 */
function canSubmitUserOnlyMessage(state: UserOnlySubmitState): boolean {
  if (state.isProcessing) return false;
  if (!state.hasContent) return false;
  if (state.isReadOnly) return false;
  if (state.disabled) return false;
  return true;
}

/**
 * Routes the control to the verdict for the send it would actually perform. It
 * chooses between {@link canSubmitMessage} and {@link canSubmitUserOnlyMessage}
 * and merges nothing: the inputs each one refuses to read are what make the two
 * different questions.
 */
export function canSubmitCurrentSend(
  state: PaidSubmitState & UserOnlySubmitState & { userOnlySend: boolean }
): boolean {
  return state.userOnlySend ? canSubmitUserOnlyMessage(state) : canSubmitMessage(state);
}

/**
 * Whether the control performs the send that spends nothing. The AI toggle alone
 * does not decide it: reaching the API's user-only route needs the handler that
 * calls it, and a composer given no handler falls back to the send that spends.
 */
export function isUserOnlySend(
  aiEnabled: boolean,
  onSubmitUserOnly: (() => void) | undefined
): onSubmitUserOnly is () => void {
  return !aiEnabled && onSubmitUserOnly !== undefined;
}

interface QueueState {
  isProcessing: boolean;
  hasQueueHandler: boolean;
  queueFull: boolean;
  /** {@link isSendable} answered for the send this queue defers, not for one made now. */
  queueable: boolean;
}

export function resolveQueueState(state: QueueState): {
  canQueue: boolean;
  showQueueFullHint: boolean;
} {
  if (!state.isProcessing || !state.hasQueueHandler) {
    return { canQueue: false, showQueueFullHint: false };
  }
  if (state.queueFull) {
    return { canQueue: false, showQueueFullHint: true };
  }
  return { canQueue: state.queueable, showQueueFullHint: false };
}

/**
 * The funding answer a send may be spent on. A denial and an absent verdict are
 * different states with the same consequence here: neither names a wallet, so
 * neither can start a paid turn.
 */
export function spendableFundingSource(
  fundingSource: PromptBudgetResult['fundingSource']
): FundingSource | undefined {
  return fundingSource === 'denied' || fundingSource === 'no_verdict' ? undefined : fundingSource;
}

/**
 * The send the control performs when activated, or `undefined` when there is
 * none to perform.
 *
 * A paid send closes over the funding source it was resolved with, so activating
 * the control cannot re-read a figure and find it gone. That is also what keeps
 * the control honest: the absence that leaves this `undefined` is the same one
 * {@link canSubmitMessage} refuses on, so an enabled control always has an
 * action.
 */
export function resolveSend(args: {
  userOnlySend: boolean;
  onSubmitUserOnly: (() => void) | undefined;
  onSubmit: (fundingSource: FundingSource) => void;
  spendable: FundingSource | undefined;
}): (() => void) | undefined {
  if (args.userOnlySend) return args.onSubmitUserOnly;
  const { onSubmit, spendable } = args;
  if (spendable === undefined) return undefined;
  return () => {
    onSubmit(spendable);
  };
}
