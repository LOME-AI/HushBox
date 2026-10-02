import * as React from 'react';
import { NOTICE_COPY, TRIAL_REMAINING_MESSAGE_ID } from '@hushbox/shared';
import { BudgetMessages } from '@/components/chat/budget/budget-messages';
import { useTrialRemaining } from '@/hooks/chat/use-trial-remaining';
import { useTrialChatStore } from '@/stores/chat/trial-chat';
import type { TrialRemaining } from '@/hooks/chat/use-trial-remaining';
import type { BudgetError } from '@hushbox/shared';

/** The reason whose sentence the count says better, so the two never both show. */
const FREE_PREVIEW_REASON = 'trial_preview_pays';

/**
 * The count, in words at both ends of the range: zero and one are spelled so the
 * sentence never opens on a bare figure, and only the middle of the range takes
 * a digit.
 */
function countClause(remaining: number): string {
  if (remaining === 0) return 'No messages left in your free preview today.';
  if (remaining === 1) return 'One message left in your free preview today.';
  return `${String(remaining)} messages left in your free preview today.`;
}

/**
 * The count as a stack element. It reads as a notice and gets a notice's
 * treatment, but it cannot BE one: every sentence in the money vocabulary is
 * magnitude-free, and a count is a magnitude. Its action clause is the
 * free-preview notice's own, so the sentence it replaces cannot drift away from
 * the sentence replacing it.
 *
 * Never "you have used N": the served number is a `min` over a session counter
 * and an IP counter, so under NAT the usage phrasing would be wrong for
 * everyone but the heaviest sharer.
 */
function trialRemainingElement(remaining: number): BudgetError {
  const segments = [
    { text: `${countClause(remaining)} ` },
    ...NOTICE_COPY[FREE_PREVIEW_REASON].action,
  ];
  return {
    id: TRIAL_REMAINING_MESSAGE_ID,
    type: 'info',
    message: segments.map((segment) => segment.text).join(''),
    segments,
  };
}

/**
 * The stack as it renders: the composer's notices, with the free-preview notice
 * swapped in place for the count once the day's allowance is partly spent.
 *
 * WHETHER it is partly spent is the publisher's verdict, not a comparison made
 * here — this file holds no message allowance to compare against. A caller
 * still holding the whole allowance has sent nothing today and is told nothing;
 * an unavailable read renders nothing rather than a guessed number.
 */
function withTrialRemaining(notices: BudgetError[], trial: TrialRemaining): BudgetError[] {
  const { remaining } = trial;
  if (trial.allowanceUntouched || remaining === undefined) return notices;
  const element = trialRemainingElement(remaining);
  const replaced = notices.findIndex((notice) => notice.id === FREE_PREVIEW_REASON);
  if (replaced === -1) return [...notices, element];
  return notices.map((notice, index) => (index === replaced ? element : notice));
}

/**
 * The stack while a trial refusal disables the composer: the refusal tile in the
 * thread already says why no message will go through, so neither the count nor
 * the free-preview notice stands beside it.
 */
function withoutTrialStanding(notices: BudgetError[]): BudgetError[] {
  return notices.filter((notice) => notice.id !== FREE_PREVIEW_REASON);
}

interface ComposerMessagesProps {
  /** The composer's notices, verdict-first, as the budget vocabulary produced them. */
  notices: BudgetError[];
  /** Whether this composer spends the free preview rather than a wallet. */
  isTrial: boolean;
  /** Whether a run is streaming; its end is what moves the count. */
  runInFlight: boolean;
  className?: string;
}

/** The composer's message stack, including what the money vocabulary may not say. */
export function ComposerMessages({
  notices,
  isTrial,
  runInFlight,
  className,
}: Readonly<ComposerMessagesProps>): React.JSX.Element {
  const trial = useTrialRemaining({ enabled: isTrial, runInFlight });
  const trialRefused = useTrialChatStore((state) => state.isRateLimited) && isTrial;
  const errors = React.useMemo(
    () => (trialRefused ? withoutTrialStanding(notices) : withTrialRemaining(notices, trial)),
    [notices, trial, trialRefused]
  );
  return <BudgetMessages errors={errors} {...(className !== undefined && { className })} />;
}
