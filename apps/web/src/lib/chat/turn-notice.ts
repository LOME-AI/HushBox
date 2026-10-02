import {
  NOTICE_COPY,
  asErrorCode,
  customUserMessage,
  friendlyErrorMessage,
  isTransientBlock,
  noticeReasonForCode,
  noticeTextOf,
  rateLimitedMessage,
  retryAfterSecondsOf,
  type MessageSegment,
  type UserFacingMessage,
} from '@hushbox/shared';

/** A failed or refused turn, as every surface that reports it reads it. */
export interface TurnNotice {
  readonly cause: string;
  /** A segment carrying `link` renders as an inline link to that route. */
  readonly action: readonly MessageSegment[];
  readonly clears: 'on_its_own' | 'when_the_user_acts';
  readonly regenerate: 'offered' | 'withheld';
}

/**
 * A sentence the notice vocabulary does not word, taken apart at its first
 * sentence end. {@link turnNoticeText} joins the halves with the one space
 * this removes, so the notice reads back as the sentence it came from.
 */
function splitSentence(sentence: string): Pick<TurnNotice, 'cause' | 'action'> {
  const match = /^(.+?[.!?]) (.+)$/s.exec(sentence);
  if (match?.[1] === undefined || match[2] === undefined) return { cause: sentence, action: [] };
  return { cause: match[1], action: [{ text: match[2] }] };
}

export function turnNoticeForCode(
  code: string,
  details?: Readonly<Record<string, unknown>>
): TurnNotice {
  const errorCode = asErrorCode(code);
  const reason = errorCode === undefined ? undefined : noticeReasonForCode(errorCode);
  if (reason !== undefined) {
    const { cause, action } = NOTICE_COPY[reason];
    return {
      cause,
      action,
      clears: isTransientBlock(reason) ? 'on_its_own' : 'when_the_user_acts',
      regenerate: 'offered',
    };
  }
  const sentence =
    errorCode === 'RATE_LIMITED'
      ? rateLimitedMessage(retryAfterSecondsOf(details))
      : friendlyErrorMessage(errorCode);
  return { ...splitSentence(sentence), clears: 'when_the_user_acts', regenerate: 'offered' };
}

function isNonEmpty<T>(items: readonly T[]): items is readonly [T, ...T[]] {
  return items.length > 0;
}

/**
 * The notice as one plain sentence: what Copy copies and a toast shows. A
 * notice with an action reads through the shared vocabulary's own join, so the
 * two can never word one condition differently.
 */
export function turnNoticeText(notice: TurnNotice): UserFacingMessage {
  const { cause, action, clears } = notice;
  if (!isNonEmpty(action)) return customUserMessage(cause);
  return customUserMessage(noticeTextOf({ cause, action, severity: { blocking: true, clears } }));
}
