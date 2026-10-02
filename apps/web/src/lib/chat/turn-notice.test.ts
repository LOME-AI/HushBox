import { describe, it, expect } from 'vitest';
import {
  ERROR_MESSAGES,
  NOTICE_COPY,
  asErrorCode,
  friendlyErrorMessage,
  noticeReasonForCode,
  type ErrorCode,
} from '@hushbox/shared';
import { turnNoticeForCode, turnNoticeText, type TurnNotice } from '@/lib/chat/turn-notice';

const EVERY_CODE = Object.keys(ERROR_MESSAGES) as ErrorCode[];

function actionText(notice: TurnNotice): string {
  return notice.action.map((segment) => segment.text).join('');
}

describe('turnNoticeForCode', () => {
  it.each(EVERY_CODE)('builds a notice for %s that reads as its sentence, whole', (code) => {
    expect(turnNoticeText(turnNoticeForCode(code))).toBe(friendlyErrorMessage(code));
  });

  it.each(EVERY_CODE.filter((code) => noticeReasonForCode(code) !== undefined))(
    'takes the cause and action of the notice condition %s describes',
    (code) => {
      const reason = noticeReasonForCode(code);
      if (reason === undefined) throw new Error(`${code} describes no notice condition`);
      const notice = turnNoticeForCode(code);

      expect(notice.cause).toBe(NOTICE_COPY[reason].cause);
      expect(notice.action).toEqual(NOTICE_COPY[reason].action);
    }
  );

  it.each(['CONCURRENT_RUN', 'RUN_CAPACITY_REACHED', 'ADMISSION_UNAVAILABLE'])(
    'says %s clears on its own',
    (code) => {
      expect(turnNoticeForCode(code).clears).toBe('on_its_own');
    }
  );

  it.each(['INSUFFICIENT_ADMISSION', 'UNAVAILABLE'])(
    'says %s clears when the user acts',
    (code) => {
      expect(turnNoticeForCode(code).clears).toBe('when_the_user_acts');
    }
  );

  it('splits a sentence the notice vocabulary does not word at its first sentence end', () => {
    const notice = turnNoticeForCode('NETWORK_ERROR');

    expect(notice.cause).toBe("We couldn't reach the AI provider.");
    expect(actionText(notice)).toBe('Check your connection and try again.');
  });

  it('gives a one-sentence message no action', () => {
    const notice = turnNoticeForCode('INCORRECT_PASSWORD');

    expect(notice.cause).toBe('Incorrect password.');
    expect(notice.action).toEqual([]);
  });

  it('words a rate limit with the wait it carries', () => {
    const notice = turnNoticeForCode('RATE_LIMITED', { retryAfterSeconds: 12 });

    expect(notice.cause).toBe('Too many attempts.');
    expect(actionText(notice)).toBe('Try again in 12 seconds.');
  });

  it('words a one-second wait in the singular', () => {
    const notice = turnNoticeForCode('RATE_LIMITED', { retryAfterSeconds: 1 });

    expect(actionText(notice)).toBe('Try again in 1 second.');
  });

  it('words a rate limit without a usable wait as a moment', () => {
    const notice = turnNoticeForCode('RATE_LIMITED', { retryAfterSeconds: 'soon' });

    expect(actionText(notice)).toBe('Try again in a moment.');
  });

  it('gives an unknown code the shared fallback sentence', () => {
    const notice = turnNoticeForCode('NOT_A_REGISTERED_CODE');

    expect(turnNoticeText(notice)).toBe(friendlyErrorMessage(asErrorCode('NOT_A_REGISTERED_CODE')));
  });

  it('says an unknown code clears when the user acts', () => {
    expect(turnNoticeForCode('NOT_A_REGISTERED_CODE').clears).toBe('when_the_user_acts');
  });

  it.each(['INSUFFICIENT_ADMISSION', 'RATE_LIMITED', 'INTERNAL', 'NOT_A_REGISTERED_CODE'])(
    'offers Regenerate for %s',
    (code) => {
      expect(turnNoticeForCode(code).regenerate).toBe('offered');
    }
  );
});

describe('turnNoticeText', () => {
  it('reads a notice with no action as its cause alone', () => {
    const notice: TurnNotice = {
      cause: 'Incorrect password.',
      action: [],
      clears: 'when_the_user_acts',
      regenerate: 'offered',
    };

    expect(turnNoticeText(notice)).toBe('Incorrect password.');
  });

  it('reads a notice whose action ends in a link as one sentence', () => {
    const notice: TurnNotice = {
      cause: "You've reached today's free trial limit.",
      action: [
        { text: 'Sign up to keep chatting.' },
        { text: ' ' },
        { text: 'Sign up free', link: '/signup' },
      ],
      clears: 'when_the_user_acts',
      regenerate: 'withheld',
    };

    expect(turnNoticeText(notice)).toBe(
      "You've reached today's free trial limit. Sign up to keep chatting. Sign up free"
    );
  });

  it('joins the cause and the action with one space', () => {
    const notice: TurnNotice = {
      cause: 'Cause.',
      action: [{ text: 'Go ' }, { text: 'here', link: '/here' }, { text: '.' }],
      clears: 'when_the_user_acts',
      regenerate: 'offered',
    };

    expect(turnNoticeText(notice)).toBe('Cause. Go here.');
  });
});
