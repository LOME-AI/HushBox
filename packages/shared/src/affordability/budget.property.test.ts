import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { composeComposerNotices } from './budget.ts';
import { NOTICE_COPY, NOTICE_REASONS, notices } from './notices.ts';
import type { NoticeReason } from './notices.ts';

type ComposerNoticesInput = Parameters<typeof composeComposerNotices>[0];

/** Every reason that blocks the send, read off the vocabulary's own declaration. */
const BLOCKING_REASONS: readonly NoticeReason[] = NOTICE_REASONS.filter(
  (reason) => NOTICE_COPY[reason].severity.blocking
);

/**
 * `noticeStackArb`: a send refusal or none, beside any verdict list drawn from
 * the whole vocabulary — repeats, several blocking notices and any order
 * included. A refusal is drawn from the blocking reasons only, because the send
 * gate refuses with nothing else.
 */
const noticeStackArb: fc.Arbitrary<ComposerNoticesInput> = fc.record({
  refusal: fc.option(fc.constantFrom(...BLOCKING_REASONS), { nil: undefined }),
  verdictNotices: fc.array(
    fc.constantFrom(...NOTICE_REASONS).map((reason) => notices(reason)),
    { maxLength: 8 }
  ),
});

function namesNegativeBalance(input: ComposerNoticesInput): boolean {
  return input.verdictNotices.some((notice) => notice.id === 'balance_negative');
}

/**
 * `negativeBalanceStackArb`: a {@link noticeStackArb} draw with the
 * negative-balance notice inserted at any position of its verdict list, so every
 * case exercises the verdict naming a negative balance.
 */
const negativeBalanceStackArb: fc.Arbitrary<ComposerNoticesInput> = fc
  .tuple(noticeStackArb, fc.nat())
  .map(([input, position]) => {
    const verdictNotices = [...input.verdictNotices];
    verdictNotices.splice(position % (verdictNotices.length + 1), 0, notices('balance_negative'));
    return { ...input, verdictNotices };
  });

describe('the composer notice stack, over every refusal and verdict list (noticeStackArb)', () => {
  it('holds at most one blocking notice', () => {
    fc.assert(
      fc.property(noticeStackArb, (input) => {
        const stack = composeComposerNotices(input);
        expect(stack.filter((notice) => notice.type === 'error').length).toBeLessThanOrEqual(1);
      })
    );
  });

  it('leads with the blocking notice when it holds one', () => {
    fc.assert(
      fc.property(noticeStackArb, (input) => {
        const stack = composeComposerNotices(input);
        const index = stack.findIndex((notice) => notice.type === 'error');
        expect(index === -1 || index === 0).toBe(true);
      })
    );
  });

  it('holds no warning under a blocking notice', () => {
    fc.assert(
      fc.property(noticeStackArb, (input) => {
        const stack = composeComposerNotices(input);
        if (stack[0]?.type !== 'error') return;
        expect(stack.some((notice) => notice.type === 'warning')).toBe(false);
      })
    );
  });

  it('keeps every info notice of the verdict, in its order', () => {
    fc.assert(
      fc.property(noticeStackArb, (input) => {
        const stack = composeComposerNotices(input);
        const infoIds = (list: readonly { type: string; id: string }[]): string[] =>
          list.filter((notice) => notice.type === 'info').map((notice) => notice.id);
        expect(infoIds(stack)).toEqual(infoIds(input.verdictNotices));
      })
    );
  });

  it('leads with the send refusal whenever there is one and the verdict names no negative balance', () => {
    fc.assert(
      fc.property(noticeStackArb, (input) => {
        if (input.refusal === undefined || namesNegativeBalance(input)) return;
        expect(composeComposerNotices(input)[0]?.id).toBe(input.refusal);
      })
    );
  });

  it('shows a negative balance the verdict names as the one blocking notice, whatever the refusal (negativeBalanceStackArb)', () => {
    fc.assert(
      fc.property(negativeBalanceStackArb, (input) => {
        const errors = composeComposerNotices(input).filter((notice) => notice.type === 'error');
        expect(errors.map((notice) => notice.id)).toEqual(['balance_negative']);
      })
    );
  });
});
