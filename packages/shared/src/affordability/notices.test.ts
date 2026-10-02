import { describe, expect, expectTypeOf, it } from 'vitest';
import { REFUSAL_CODES, SELECTION_CAUSED_REASONS, refusalPrecedence } from './turn/turn-types.ts';
import {
  NOTICE_COPY,
  NOTICE_REASONS,
  SELECTION_CAUSED_COPY,
  TRIAL_REMAINING_MESSAGE_ID,
  isTransientBlock,
  notices,
  noticeText,
  noticeTextOf,
  refusesRegenerate,
} from './notices.ts';
import { ROUTES } from '../platform/routes.ts';
import type { BudgetError, ComposerNoticeId, NoticeCopy, NoticeReason } from './notices.ts';

/** Every reason, once — the enumeration every structural assertion runs over. */
const EVERY_REASON: readonly NoticeReason[] = NOTICE_REASONS;

/**
 * A magnitude is an amount, a token count or a threshold (§Notices 6). Digits
 * and currency marks catch the amounts; the nouns catch the spelled-out
 * thresholds a number-free sentence can still leak.
 */
const MAGNITUDE = /\d|[$¢%]|\btokens?\b|\bcents?\b|\bdollars?\b|\bthresholds?\b|\blimits?\b/i;

function fullText(reason: NoticeReason): string {
  const notice = notices(reason);
  return `${notice.message} ${notice.segments.map((segment) => segment.text).join('')}`;
}

describe('the notice vocabulary', () => {
  it('covers every refusal code the turn arithmetic can produce', () => {
    for (const code of REFUSAL_CODES) {
      expect(NOTICE_REASONS).toContain(code);
    }
  });

  it('names each reason exactly once', () => {
    expect(new Set(NOTICE_REASONS).size).toBe(NOTICE_REASONS.length);
  });

  it('gives every reason exactly one wording, shared with no other reason', () => {
    const wordings = EVERY_REASON.map((reason) => noticeText(reason));
    for (const wording of wordings) expect(wording.length).toBeGreaterThan(0);
    expect(new Set(wordings).size).toBe(wordings.length);
  });

  it('renders the same wording from the notice as from the plain text', () => {
    for (const reason of EVERY_REASON) {
      expect(notices(reason).message).toBe(noticeText(reason));
    }
  });

  it('gives every reason an action clause', () => {
    for (const reason of EVERY_REASON) {
      const action = notices(reason).segments.slice(1);
      expect(action.length).toBeGreaterThan(0);
      expect(
        action
          .map((segment) => segment.text)
          .join('')
          .trim().length
      ).toBeGreaterThan(0);
    }
  });

  it('names no amount, token count or threshold in any wording', () => {
    for (const reason of EVERY_REASON) {
      expect(fullText(reason)).not.toMatch(MAGNITUDE);
    }
  });

  it('identifies every notice by its own reason', () => {
    for (const reason of EVERY_REASON) {
      expect(notices(reason).id).toBe(reason);
    }
  });

  // "Selected" is a claim about the picker's state, and these sentences render
  // in a modal opened by clicking ONE row: a row that is not the selection and
  // may never become it. The demonstrative names the model the sentence is
  // about, whatever the picker currently holds.
  it('says "the selected model" in no cause, because a clicked row is not the selection', () => {
    for (const reason of EVERY_REASON) {
      expect(NOTICE_COPY[reason].cause.toLowerCase()).not.toContain('the selected model');
    }
  });

  // `boundReason` reaches this code only after the funding AND the context
  // headroom have both cleared the same requirement, so what refused is the
  // model's own completion cap. Executed against the producer: a model with a
  // cap below a minimum answer is refused with this code on an EMPTY
  // conversation, which is why the sentence may not blame the conversation.
  it('blames the model, not the conversation, when the output cap is what refused', () => {
    expect(NOTICE_COPY.model_output_cap_too_low.cause.toLowerCase()).not.toContain('conversation');
  });
});

describe('severity is structural', () => {
  const blocking = EVERY_REASON.filter((reason) => NOTICE_COPY[reason].severity.blocking);
  const informational = EVERY_REASON.filter((reason) => !NOTICE_COPY[reason].severity.blocking);

  it('renders every blocking reason as an error', () => {
    expect(blocking.length).toBeGreaterThan(0);
    for (const reason of blocking) {
      expect(notices(reason).type).toBe('error');
    }
  });

  it('renders every informational reason as a warning or an info notice', () => {
    expect(informational.length).toBeGreaterThan(0);
    for (const reason of informational) {
      expect(['warning', 'info']).toContain(notices(reason).type);
    }
  });

  it('leaves no error severity that is not a blocking reason', () => {
    for (const reason of EVERY_REASON) {
      expect(notices(reason).type === 'error').toBe(NOTICE_COPY[reason].severity.blocking);
    }
  });

  // Quantified over the vocabulary on purpose. Naming today's members here
  // would answer for them and stay silent about the next one added, which is
  // the failure this classification exists to prevent: the surfaces that defer
  // an action past a block read the declaration, so an unclassified reason
  // would silently fall into whichever half the reader defaults to.
  it('splits the blocking reasons into the ones that end on their own and the ones that need the user', () => {
    const endsOnItsOwn = blocking.filter((reason) => isTransientBlock(reason));
    const needsTheUser = blocking.filter((reason) => !isTransientBlock(reason));

    expect(endsOnItsOwn.length).toBeGreaterThan(0);
    expect(needsTheUser.length).toBeGreaterThan(0);
  });

  it('calls no informational reason a transient block, because a notice that does not block has nothing to wait out', () => {
    expect(informational.length).toBeGreaterThan(0);
    for (const reason of informational) {
      expect(isTransientBlock(reason)).toBe(false);
    }
  });

  it('never calls a reason transient without also blocking on it', () => {
    for (const reason of EVERY_REASON) {
      if (isTransientBlock(reason)) {
        expect(NOTICE_COPY[reason].severity.blocking).toBe(true);
      }
    }
  });

  it('carries on every blocking notice what its reason declares ends the block', () => {
    for (const reason of blocking) {
      const { severity } = NOTICE_COPY[reason];
      if (!severity.blocking) throw new Error(`${reason} was filtered as blocking`);
      expect(notices(reason).blockClears).toBe(severity.clears);
    }
  });

  it('carries no block end on a notice that does not block', () => {
    for (const reason of informational) {
      expect(notices(reason)).not.toHaveProperty('blockClears');
    }
  });
});

describe('precedence between money and length', () => {
  it('answers money when the funding cannot cover a minimum answer', () => {
    expect(noticeText(refusalPrecedence(['prompt_too_long', 'insufficient_funds']))).toBe(
      noticeText('insufficient_funds')
    );
  });

  it('answers length when only the prompt makes the turn infeasible', () => {
    expect(noticeText(refusalPrecedence(['prompt_too_long']))).toBe(noticeText('prompt_too_long'));
  });

  it('gives the money and length conditions different wordings', () => {
    expect(noticeText('insufficient_funds')).not.toBe(noticeText('prompt_too_long'));
  });
});

describe('a hold is not poverty', () => {
  it('words a held-funds block differently from an empty balance', () => {
    expect(noticeText('funds_held_by_run')).not.toBe(noticeText('insufficient_funds'));
  });

  it('offers no payment path, because paying would not help', () => {
    for (const segment of notices('funds_held_by_run').segments) {
      expect(segment.link).toBeUndefined();
    }
  });

  it('tells the user to wait', () => {
    expect(noticeText('funds_held_by_run').toLowerCase()).toContain('wait');
  });

  it('names no conversation', () => {
    expect(noticeText('funds_held_by_run').toLowerCase()).not.toContain('conversation');
  });
});

describe('a balance below zero', () => {
  it('says the balance is below zero and that adding credit sends again', () => {
    expect(noticeText('balance_negative')).toBe(
      'Your balance is below zero. Add credit to send messages again.'
    );
  });

  it('links its add-credit action to Billing', () => {
    expect(notices('balance_negative').action[0]).toEqual({
      text: 'Add credit',
      link: ROUTES.BILLING,
    });
  });

  it('blocks the send until the user acts', () => {
    expect(NOTICE_COPY.balance_negative.severity).toEqual({
      blocking: true,
      clears: 'when_the_user_acts',
    });
  });
});

describe('reasons whose only remedy is someone else', () => {
  it('gives a guest with no allocation no top-up path', () => {
    for (const segment of notices('guest_no_group_budget').segments) {
      expect(segment.link).not.toBe(ROUTES.BILLING);
    }
    expect(noticeText('guest_no_group_budget').toLowerCase()).toContain('owner');
  });

  it('names the owner as the remedy when the owner-funded turn cannot be paid for', () => {
    expect(noticeText('group_owner_funds_unavailable').toLowerCase()).toContain('owner');
  });

  it('words the owner refusal differently from the unallocated-guest refusal', () => {
    expect(noticeText('group_owner_funds_unavailable')).not.toBe(
      noticeText('guest_no_group_budget')
    );
  });
});

describe('the condition-neutral send refusal', () => {
  // Two producers reach this copy — the admission balance gate (spendable funds
  // MINUS reserved funds) and the Smart Model build with no affordable candidate
  // — and between them an empty balance, funds held by a run in flight, an
  // exhausted group headroom and a spent daily allowance all arrive
  // indistinguishable while demanding different actions. The copy must be true
  // of all of them and must offer no action that is false for any: naming the
  // balance alone would tell a payer with ample funds to pay.
  it('names no single condition', () => {
    for (const condition of ['insufficient_funds', 'funds_held_by_run'] as const) {
      expect(noticeText('send_cannot_start')).not.toBe(noticeText(condition));
    }
  });

  it('offers no payment path', () => {
    for (const segment of notices('send_cannot_start').segments) {
      expect(segment.link).toBeUndefined();
    }
    expect(noticeText('send_cannot_start').toLowerCase()).not.toContain('add credit');
  });

  it('offers waiting as well as checking, since either may be the remedy', () => {
    const text = noticeText('send_cannot_start').toLowerCase();
    expect(text).toContain('wait');
    expect(text).toContain('balance');
  });

  it('offers the budget action too, since a group send reaches this same wording', () => {
    // The Smart Model route answers this code when no candidate fits the payer's
    // effective funding, which is the owner's headroom for a group turn and the
    // remaining daily allowance for a free-tier sender. Without this clause that
    // sender is told to check a balance that is not what bound.
    expect(noticeText('send_cannot_start').toLowerCase()).toContain('budget');
  });
});

describe('reasons a paid action can hit', () => {
  it('words the concurrent-run refusal once, with an action', () => {
    expect(NOTICE_COPY.run_already_in_progress.severity.blocking).toBe(true);
    expect(noticeText('run_already_in_progress').toLowerCase()).toContain('wait');
  });

  it('splits premium into the two conditions whose actions differ', () => {
    expect(noticeText('premium_requires_account')).not.toBe(noticeText('premium_requires_credit'));
    expect(
      notices('premium_requires_account').segments.some((segment) => segment.link === ROUTES.SIGNUP)
    ).toBe(true);
    expect(
      notices('premium_requires_credit').segments.some((segment) => segment.link === ROUTES.BILLING)
    ).toBe(true);
  });
});

describe('the refusals a regenerate is exempt from', () => {
  it('exempts the premium refusal that asks for an account', () => {
    expect(refusesRegenerate('premium_requires_account')).toBe(false);
  });

  it('exempts the premium refusal that asks for credit', () => {
    expect(refusesRegenerate('premium_requires_credit')).toBe(false);
  });

  it('still refuses a re-run the payer cannot fund', () => {
    expect(refusesRegenerate('insufficient_funds')).toBe(true);
  });

  it('still refuses a re-run whose funding could not be read', () => {
    expect(refusesRegenerate('send_check_unavailable')).toBe(true);
  });

  it('refuses a re-run on every reason outside the entitlement pair', () => {
    const exempt = EVERY_REASON.filter((reason) => !refusesRegenerate(reason));

    expect(exempt).toEqual(['premium_requires_account', 'premium_requires_credit']);
  });
});

describe('the copy for a row its own selection blocks', () => {
  const textOf = (copy: NoticeCopy): string =>
    `${copy.cause} ${copy.action.map((segment) => segment.text).join('')}`;
  const linksOf = (copy: NoticeCopy): (string | undefined)[] =>
    copy.action.map((segment) => segment.link).filter((link) => link !== undefined);

  it('words every reason a sibling can impose, and no other', () => {
    expect(new Set(Object.keys(SELECTION_CAUSED_COPY))).toStrictEqual(
      new Set(SELECTION_CAUSED_REASONS)
    );
  });

  it('gives every one of them an action clause', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      const action = SELECTION_CAUSED_COPY[reason].action;
      expect(
        action
          .map((segment) => segment.text)
          .join('')
          .trim().length
      ).toBeGreaterThan(0);
    }
  });

  it('names no amount, token count or threshold in any of them', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      expect(textOf(SELECTION_CAUSED_COPY[reason])).not.toMatch(MAGNITUDE);
    }
  });

  // The variant exists to ADD a remedy, so it may not drop the one the ordinary
  // wording offers: a row blocked by a sibling still has the true condition to
  // clear, and the link is where that is cleared.
  it('keeps every destination the ordinary wording offers', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      expect(linksOf(SELECTION_CAUSED_COPY[reason])).toStrictEqual(linksOf(NOTICE_COPY[reason]));
    }
  });

  it('offers removing the selected model in every one of them', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      expect(
        SELECTION_CAUSED_COPY[reason].action
          .map((segment) => segment.text)
          .join('')
          .toLowerCase()
      ).toContain('remove');
    }
  });

  it('words each one differently from the reason`s ordinary copy', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      expect(textOf(SELECTION_CAUSED_COPY[reason])).not.toBe(textOf(NOTICE_COPY[reason]));
    }
  });

  // A picker row renders the ACTION segments alone — the cause reaches it as
  // screen-reader text — so an action that continues the cause's sentence would
  // read, for a sighted user, as a sentence about the row they clicked. Each
  // action therefore opens its own sentence.
  it('opens every action clause as a sentence of its own', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      const [first] = SELECTION_CAUSED_COPY[reason].action;
      const opening = first.text.trimStart().slice(0, 1);
      expect(opening).toBe(opening.toUpperCase());
    }
  });

  it('blocks on every one of them', () => {
    for (const reason of SELECTION_CAUSED_REASONS) {
      expect(SELECTION_CAUSED_COPY[reason].severity.blocking).toBe(true);
    }
  });
});

describe('the rendered sentence for a copy', () => {
  // The picker row is why this entry point exists: it renders the variant map's
  // wording, and the variant and the ordinary map share their keys, so nothing
  // keyed by reason can reach it.
  it('renders a copy the reason-keyed entry point cannot reach', () => {
    expect(noticeTextOf(SELECTION_CAUSED_COPY.premium_requires_account)).toBe(
      "A model you've selected needs an account. Sign up to chat with premium models, or remove the selected model."
    );
  });

  it('renders the reason-keyed entry point`s own sentence for every reason', () => {
    for (const reason of EVERY_REASON) {
      expect(noticeText(reason)).toBe(noticeTextOf(NOTICE_COPY[reason]));
    }
  });
});

describe('the notice for a refused row', () => {
  it('words a refusal the producer attributed to the model in the ordinary vocabulary', () => {
    expect(
      notices({ available: false, reason: 'insufficient_funds', causedBy: 'model' }).message
    ).toBe(noticeText('insufficient_funds'));
  });

  // The misattribution this entry point exists to remove: both maps are keyed
  // by the same reasons, so a producer taking only the reason cannot reach the
  // variant and words a row its selection blocked as though the model itself
  // were the problem.
  it('words a refusal the producer attributed to the selection in the variant vocabulary', () => {
    expect(
      notices({ available: false, reason: 'insufficient_funds', causedBy: 'selection' }).message
    ).toBe(noticeTextOf(SELECTION_CAUSED_COPY.insufficient_funds));
  });

  // Two channels, not one rendering. A picker row shows the action clause and
  // sends the whole sentence to a screen reader, so the producer hands back
  // both rather than a sentence the surface would have to take apart.
  it('carries the action clause apart from the whole sentence', () => {
    const refusal = { available: false, reason: 'prompt_too_long', causedBy: 'selection' } as const;

    expect(notices(refusal).action).toStrictEqual(SELECTION_CAUSED_COPY.prompt_too_long.action);
  });
});

describe('the composer notice ids', () => {
  it('names the trial-count element by its own id', () => {
    expect(TRIAL_REMAINING_MESSAGE_ID).toBe('trial_messages_remaining');
  });

  // The count rides the notice stack but states a magnitude, which no notice
  // sentence may, so no reason may ever take its id.
  it('keeps the trial-count id out of the notice reasons', () => {
    expect([...NOTICE_REASONS]).not.toContain(TRIAL_REMAINING_MESSAGE_ID);
  });

  it('admits a notice reason or the trial-count id and nothing else', () => {
    expectTypeOf<ComposerNoticeId>().toEqualTypeOf<
      NoticeReason | typeof TRIAL_REMAINING_MESSAGE_ID
    >();
  });

  it('identifies every composer notice by a composer notice id', () => {
    expectTypeOf<BudgetError['id']>().toEqualTypeOf<ComposerNoticeId>();
  });
});
