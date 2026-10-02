import { describe, it, expect } from 'vitest';
import { ROUTES } from '@hushbox/shared';
import { trialRefusalFor } from '@/lib/chat/trial-refusals';
import { ChatRequestError } from '@/lib/chat/request-error';
import { turnNoticeForCode, turnNoticeText } from '@/lib/chat/turn-notice';

const SIGN_UP_LINK = { text: 'Sign up free', link: ROUTES.SIGNUP };

describe('trialRefusalFor', () => {
  describe('quota-exhausted refusals disable the composer', () => {
    it.each(['TRIAL_LIMIT_REACHED', 'DAILY_LIMIT_EXCEEDED'])(
      'words %s as the trial limit with a sign-up link and no Regenerate',
      (code) => {
        const refusal = trialRefusalFor(new ChatRequestError(code));

        expect(refusal).toEqual({
          notice: {
            cause: "You've reached today's free trial limit.",
            action: [{ text: 'Sign up to keep chatting.' }, { text: ' ' }, SIGN_UP_LINK],
            clears: 'when_the_user_acts',
            regenerate: 'withheld',
          },
          disablesComposer: true,
        });
      }
    );

    it('withholds Regenerate when the trial pool is full', () => {
      const refusal = trialRefusalFor(new ChatRequestError('TRIAL_CAPACITY_REACHED'));

      expect(refusal?.notice.regenerate).toBe('withheld');
      expect(refusal?.disablesComposer).toBe(true);
    });

    it('links a signed-in user into the app instead of to sign-up, without Regenerate', () => {
      const refusal = trialRefusalFor(
        new ChatRequestError('AUTHENTICATED_ON_TRIAL', undefined, 403)
      );

      expect(refusal).toEqual({
        notice: {
          cause: 'Signed-in users should use the main chat, not the trial.',
          action: [{ text: 'Go to your chats', link: ROUTES.CHAT }],
          clears: 'when_the_user_acts',
          regenerate: 'withheld',
        },
        disablesComposer: true,
      });
    });
  });

  describe('recoverable refusals keep the composer enabled', () => {
    it.each([
      'TRIAL_MESSAGE_TOO_EXPENSIVE',
      'PREMIUM_REQUIRES_ACCOUNT',
      'MEDIA_TRIAL_BLOCKED',
      'FEATURE_REQUIRES_AUTH',
    ] as const)('words %s from its shared copy, then the sign-up link', (code) => {
      const refusal = trialRefusalFor(new ChatRequestError(code));
      if (refusal === null) throw new Error(`${code} is not a trial refusal`);

      expect(refusal.disablesComposer).toBe(false);
      expect(refusal.notice.action.at(-1)).toEqual(SIGN_UP_LINK);
      expect(turnNoticeText(refusal.notice)).toBe(
        `${turnNoticeText(turnNoticeForCode(code))} Sign up free`
      );
    });

    it('offers Regenerate for a message too costly for the trial', () => {
      const refusal = trialRefusalFor(new ChatRequestError('TRIAL_MESSAGE_TOO_EXPENSIVE'));

      expect(refusal?.notice.regenerate).toBe('offered');
    });

    it('words a rate limit with its wait, then the sign-up link', () => {
      const refusal = trialRefusalFor(
        new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 30 })
      );

      expect(refusal).toEqual({
        notice: {
          cause: 'Too many attempts.',
          action: [{ text: 'Try again in 30 seconds.' }, { text: ' ' }, SIGN_UP_LINK],
          clears: 'when_the_user_acts',
          regenerate: 'offered',
        },
        disablesComposer: false,
      });
    });

    it('words a rate limit carrying no details as a moment', () => {
      const refusal = trialRefusalFor({ code: 'RATE_LIMITED' });

      expect(refusal?.notice.action[0]).toEqual({ text: 'Try again in a moment.' });
    });

    it('words a rate limit whose wait is not a number as a moment', () => {
      const refusal = trialRefusalFor(
        new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 'soon' })
      );

      expect(refusal?.notice.action[0]).toEqual({ text: 'Try again in a moment.' });
    });
  });

  describe('non-refusals return null', () => {
    it('returns null for an unmapped code', () => {
      expect(trialRefusalFor(new ChatRequestError('INTERNAL'))).toBeNull();
    });

    it('returns null for an error without a code', () => {
      expect(trialRefusalFor(new Error('Network error'))).toBeNull();
    });

    it('returns null for a non-object error', () => {
      expect(trialRefusalFor('boom')).toBeNull();
    });

    it('returns null for a non-string code', () => {
      expect(trialRefusalFor({ code: 429 })).toBeNull();
    });
  });
});
