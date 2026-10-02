import { describe, it, expect } from 'vitest';
import { HOUR_MS, TEST_DAY_START, isoAt, testUuidV7 } from '../testing/test-time.ts';

import { MAX_BANNER_LINK_TEXT_LENGTH, MAX_BANNER_TEXT_LENGTH } from '../schemas/api/announcements';
import { BUCKET_MAXIMUM_NOTE } from '../growth/funnel-steps.ts';
import {
  ADMIN_OP_CONTRACTS,
  ADMIN_OP_NAMES,
  MAX_ADMIN_MODEL_ID_LENGTH,
  MAX_ADMIN_NEWSLETTER_BODY_LENGTH,
  MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH,
  MAX_ADMIN_REASON_LENGTH,
  MAX_ADMIN_TRANSACTION_ID_LENGTH,
  MAX_STRANDED_TOTP_GROUPS,
  MAX_TOTP_KEY_ID_HEX_LENGTH,
} from './ops';
import type { AdminOpContract } from './contract';

const VALID_UUID = testUuidV7(1);
const REASON = 'support ticket #123';

/** The admin op inventory: name → [inverse, effectClass, kind]. */
const EXPECTED_INVENTORY: Record<
  string,
  [string | null, AdminOpContract['effectClass'], AdminOpContract['kind']]
> = {
  'wallet.credit': ['wallet.clawback', 'durable', 'mutation'],
  'wallet.clawback': ['wallet.credit', 'durable', 'mutation'],
  'user.lock': ['user.unlock', 'durable', 'mutation'],
  'user.unlock': ['user.lock', 'durable', 'mutation'],
  'sessions.revokeAll': [null, 'system-owned', 'mutation'],
  'job.redrive': [null, 'system-owned', 'mutation'],
  'job.discard': ['job.restore', 'durable', 'mutation'],
  'job.restore': ['job.discard', 'durable', 'mutation'],
  'model.disable': ['model.enable', 'durable', 'mutation'],
  'model.enable': ['model.disable', 'durable', 'mutation'],
  'share.revoke': ['share.unrevoke', 'durable', 'mutation'],
  'share.unrevoke': ['share.revoke', 'durable', 'mutation'],
  'feedback.setStatus': ['feedback.setStatus', 'durable', 'mutation'],
  'banner.set': ['banner.set', 'durable', 'mutation'],
  'newsletter.schedule': ['newsletter.cancel', 'durable', 'mutation'],
  'newsletter.cancel': ['newsletter.schedule', 'durable', 'mutation'],
  'newsletter.testSend': [null, 'ephemeral', 'mutation'],
  'payment.forceExpire': ['payment.restoreAwaitingWebhook', 'durable', 'mutation'],
  'payment.restoreAwaitingWebhook': ['payment.forceExpire', 'durable', 'mutation'],
  'payment.forceCompleteAndCredit': ['payment.uncompleteAndClawback', 'durable', 'mutation'],
  'payment.uncompleteAndClawback': ['payment.forceCompleteAndCredit', 'durable', 'mutation'],
  'twoFactor.clearStranded': ['twoFactor.restoreStranded', 'durable', 'mutation'],
  'twoFactor.restoreStranded': ['twoFactor.clearStranded', 'durable', 'mutation'],
  'twoFactor.clear': ['twoFactor.restore', 'durable', 'mutation'],
  'twoFactor.restore': ['twoFactor.clear', 'durable', 'mutation'],
  'growth.campaign.create': ['growth.campaign.archive', 'durable', 'mutation'],
  'growth.campaign.archive': ['growth.campaign.create', 'durable', 'mutation'],
  'growth.freshness.read': [null, 'ephemeral', 'read'],
  'growth.funnel.read': [null, 'ephemeral', 'read'],
  'growth.marketing.read': [null, 'ephemeral', 'read'],
  'growth.sources.read': [null, 'ephemeral', 'read'],
  'growth.campaigns.read': [null, 'ephemeral', 'read'],
  'growth.events.read': [null, 'ephemeral', 'read'],
  'growth.reach.read': [null, 'ephemeral', 'read'],
};

const byName = (a: string, b: string): number => a.localeCompare(b);

/**
 * The reason law binds mutations only — `defineAdminOpContract` applies it
 * behind `kind === 'mutation'`, because a read justifies nothing and records
 * no act. Derived from the contracts rather than listed, so a new mutation
 * joins these loops without an edit here.
 */
const MUTATION_OP_NAMES = ADMIN_OP_NAMES.filter(
  (name) => ADMIN_OP_CONTRACTS[name].kind === 'mutation'
);

describe('ADMIN_OP_CONTRACTS inventory', () => {
  it('contains exactly the v1 admin ops, plus nothing', () => {
    expect([...ADMIN_OP_NAMES].toSorted(byName)).toEqual(
      Object.keys(EXPECTED_INVENTORY).toSorted(byName)
    );
  });

  it.each(Object.entries(EXPECTED_INVENTORY))(
    '%s has the registered inverse, effect class and kind',
    (name, [inverse, effectClass, kind]) => {
      const contract = ADMIN_OP_CONTRACTS[name as keyof typeof ADMIN_OP_CONTRACTS];
      expect(contract.name).toBe(name);
      expect(contract.inverse).toBe(inverse);
      expect(contract.effectClass).toBe(effectClass);
      expect(contract.kind).toBe(kind);
    }
  );

  it('gives every system-owned op a stated reason and no inverse', () => {
    const systemOwned = ADMIN_OP_NAMES.filter(
      (name) => ADMIN_OP_CONTRACTS[name].effectClass === 'system-owned'
    );

    expect(systemOwned.length).toBeGreaterThan(0);
    for (const name of systemOwned) {
      const contract = ADMIN_OP_CONTRACTS[name];
      expect(contract.inverse).toBeNull();
      expect((contract.systemOwnedReason ?? '').trim()).not.toBe('');
    }
  });

  it('states a system-owned reason on no op of another class', () => {
    for (const name of ADMIN_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      if (contract.effectClass === 'system-owned') continue;
      expect(contract.systemOwnedReason, name).toBeUndefined();
    }
  });

  it('every declared inverse is itself a registered op pointing back', () => {
    for (const name of ADMIN_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      if (contract.inverse !== null) {
        const inverse = ADMIN_OP_CONTRACTS[contract.inverse as keyof typeof ADMIN_OP_CONTRACTS];
        expect(inverse, `${name} inverse ${contract.inverse} missing`).toBeDefined();
        expect(inverse.inverse).toBe(name);
      }
    }
  });

  it('every mutation accepts a reason exactly at the length cap', () => {
    for (const name of MUTATION_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      const valid = VALID_INPUTS[name];
      expect(
        contract.input.safeParse({ ...valid, reason: 'a'.repeat(MAX_ADMIN_REASON_LENGTH) }).success,
        `${name} reason at cap`
      ).toBe(true);
    }
  });

  it('every mutation rejects a reason over the length cap', () => {
    for (const name of MUTATION_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      const valid = VALID_INPUTS[name];
      expect(
        contract.input.safeParse({ ...valid, reason: 'a'.repeat(MAX_ADMIN_REASON_LENGTH + 1) })
          .success,
        `${name} reason over cap`
      ).toBe(false);
    }
  });

  it('every mutation rejects an input missing reason', () => {
    for (const name of MUTATION_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      const valid = VALID_INPUTS[name];
      const withoutReason = Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== 'reason')
      );
      expect(contract.input.safeParse(withoutReason).success, `${name} without reason`).toBe(false);
      expect(
        contract.input.safeParse({ ...valid, reason: '' }).success,
        `${name} empty reason`
      ).toBe(false);
      expect(
        contract.input.safeParse({ ...valid, reason: ' \t\n ' }).success,
        `${name} whitespace-only reason`
      ).toBe(false);
      expect(contract.input.safeParse(valid).success, `${name} valid input`).toBe(true);
    }
  });
});

const walletInput = { walletId: VALID_UUID, amountNanoUsd: '5000000000', reason: REASON };
const userInput = { userId: VALID_UUID, reason: REASON };
const jobInput = { jobId: VALID_UUID, reason: REASON };
const modelInput = { modelId: 'openai/gpt-5', reason: REASON };
const shareInput = { linkId: VALID_UUID, reason: REASON };
const paymentInput = { paymentId: VALID_UUID, reason: REASON };
const growthWindow = { from: isoAt(TEST_DAY_START), to: isoAt(TEST_DAY_START + HOUR_MS) };

const VALID_INPUTS: Record<(typeof ADMIN_OP_NAMES)[number], Record<string, unknown>> = {
  'wallet.credit': walletInput,
  'wallet.clawback': walletInput,
  'user.lock': { ...userInput, lockReason: 'admin' },
  'user.unlock': userInput,
  'sessions.revokeAll': userInput,
  'job.redrive': jobInput,
  'job.discard': jobInput,
  'job.restore': jobInput,
  'model.disable': modelInput,
  'model.enable': modelInput,
  'share.revoke': shareInput,
  'share.unrevoke': shareInput,
  'feedback.setStatus': { feedbackId: VALID_UUID, status: 'triaged', reason: REASON },
  'banner.set': {
    enabled: true,
    messages: [{ variant: 'info', text: 'Scheduled maintenance tonight' }],
    reason: REASON,
  },
  'newsletter.schedule': {
    subject: 'July product update',
    bodyMarkdown: '# Hello',
    scheduledAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
    reason: REASON,
  },
  'newsletter.cancel': { issueId: VALID_UUID, reason: REASON },
  'newsletter.testSend': { subject: 'Draft check', bodyMarkdown: '# Hello', reason: REASON },
  'twoFactor.clearStranded': { reason: REASON },
  'twoFactor.restoreStranded': {
    groups: [{ fingerprint: '00112233445566aa', count: 3 }],
    reason: REASON,
  },
  'payment.forceExpire': paymentInput,
  'payment.restoreAwaitingWebhook': paymentInput,
  'payment.forceCompleteAndCredit': paymentInput,
  'payment.uncompleteAndClawback': paymentInput,
  'twoFactor.clear': userInput,
  'twoFactor.restore': userInput,
  'growth.campaign.create': { tag: 'launch-2026', label: 'Launch 2026', reason: REASON },
  'growth.campaign.archive': { tag: 'launch-2026', reason: REASON },
  'growth.freshness.read': {},
  'growth.funnel.read': growthWindow,
  'growth.marketing.read': { ...growthWindow, grain: 'day' },
  'growth.sources.read': growthWindow,
  'growth.campaigns.read': {},
  'growth.events.read': growthWindow,
  'growth.reach.read': growthWindow,
};

describe('wallet op inputs', () => {
  it('parse amountNanoUsd from the NanoUSD wire string into a bigint', () => {
    const parsed = ADMIN_OP_CONTRACTS['wallet.credit'].input.parse({
      walletId: VALID_UUID,
      amountNanoUsd: '5000000000',
      reason: REASON,
    });
    expect(parsed.amountNanoUsd).toBe(5_000_000_000n);
  });

  it('reject a zero or negative amount', () => {
    for (const amount of ['0', '-1']) {
      const result = ADMIN_OP_CONTRACTS['wallet.clawback'].input.safeParse({
        walletId: VALID_UUID,
        amountNanoUsd: amount,
        reason: REASON,
      });
      expect(result.success).toBe(false);
    }
  });

  it('reject a non-canonical amount string', () => {
    const result = ADMIN_OP_CONTRACTS['wallet.credit'].input.safeParse({
      walletId: VALID_UUID,
      amountNanoUsd: '1e9',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  // The only assertion over the wallet cap that does not move with it: the
  // wire-side table in `catalog-projection.test.ts` derives from the same
  // exported constant, so a constant-side change moves expectation and code
  // together and leaves every case there green. What this case catches is
  // exactly the declared cap ceasing to be a positive bigint — zero, a
  // negative, a non-bigint and a dropped `guardrails` each red it. What
  // nothing in this package's admin suite catches is the cap's MAGNITUDE:
  // doubling the constant, or collapsing it to five nano-USD, leaves all of
  // it green.
  it('carry the wallet-adjustment cap guardrail', () => {
    for (const name of ['wallet.credit', 'wallet.clawback'] as const) {
      const guardrails = ADMIN_OP_CONTRACTS[name].guardrails;
      expect(guardrails.maxAmountNanoUsd).toBeTypeOf('bigint');
      expect(guardrails.maxAmountNanoUsd).toBeGreaterThan(0n);
    }
  });
});

describe('targeted op inputs', () => {
  it('user.lock rejects an unknown lockReason', () => {
    const result = ADMIN_OP_CONTRACTS['user.lock'].input.safeParse({
      userId: VALID_UUID,
      lockReason: 'because',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('uuid-targeted ops reject a non-uuid target', () => {
    const result = ADMIN_OP_CONTRACTS['job.redrive'].input.safeParse({
      jobId: 'not-a-uuid',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('model ops reject an empty modelId', () => {
    const result = ADMIN_OP_CONTRACTS['model.disable'].input.safeParse({
      modelId: '',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('model ops accept a modelId exactly at the length cap', () => {
    const result = ADMIN_OP_CONTRACTS['model.disable'].input.safeParse({
      modelId: 'a'.repeat(MAX_ADMIN_MODEL_ID_LENGTH),
      reason: REASON,
    });
    expect(result.success).toBe(true);
  });

  it('model ops reject a modelId over the length cap', () => {
    const result = ADMIN_OP_CONTRACTS['model.enable'].input.safeParse({
      modelId: 'a'.repeat(MAX_ADMIN_MODEL_ID_LENGTH + 1),
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('payment ops accept a helcimTransactionId exactly at the length cap', () => {
    const result = ADMIN_OP_CONTRACTS['payment.restoreAwaitingWebhook'].input.safeParse({
      paymentId: VALID_UUID,
      helcimTransactionId: 'a'.repeat(MAX_ADMIN_TRANSACTION_ID_LENGTH),
      reason: REASON,
    });
    expect(result.success).toBe(true);
  });

  it('payment ops reject a helcimTransactionId over the length cap', () => {
    const result = ADMIN_OP_CONTRACTS['payment.forceExpire'].input.safeParse({
      paymentId: VALID_UUID,
      helcimTransactionId: 'a'.repeat(MAX_ADMIN_TRANSACTION_ID_LENGTH + 1),
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('feedback.setStatus rejects an unknown status', () => {
    const result = ADMIN_OP_CONTRACTS['feedback.setStatus'].input.safeParse({
      feedbackId: VALID_UUID,
      status: 'archived',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });
});

describe('banner.set input', () => {
  const bannerInput = (message: Record<string, unknown>): Record<string, unknown> => ({
    enabled: true,
    messages: [message],
    reason: REASON,
  });
  const parse = (input: Record<string, unknown>): boolean =>
    ADMIN_OP_CONTRACTS['banner.set'].input.safeParse(input).success;

  it('accepts a message with a safe absolute https href', () => {
    expect(
      parse(bannerInput({ variant: 'warning', text: 'Read this', href: 'https://hushbox.ai/blog' }))
    ).toBe(true);
  });

  it('accepts zero messages — the disabled state and undo-of-first-set', () => {
    expect(parse({ enabled: false, messages: [], reason: REASON })).toBe(true);
  });

  it('rejects an unknown variant instead of salvaging it', () => {
    expect(parse(bannerInput({ variant: 'danger', text: 'x' }))).toBe(false);
  });

  it('rejects empty and whitespace-only text', () => {
    expect(parse(bannerInput({ variant: 'info', text: '' }))).toBe(false);
    expect(parse(bannerInput({ variant: 'info', text: ' \t ' }))).toBe(false);
  });

  it('rejects text over 280 characters', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'a'.repeat(281) }))).toBe(false);
    expect(parse(bannerInput({ variant: 'info', text: 'a'.repeat(280) }))).toBe(true);
  });

  it('rejects unsafe hrefs', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example',
      '/relative/path',
      'not a url',
    ]) {
      expect(parse(bannerInput({ variant: 'info', text: 'x', href })), href).toBe(false);
    }
  });

  it('rejects more than 20 messages', () => {
    const messages = Array.from({ length: 21 }, () => ({ variant: 'info', text: 'x' }));
    expect(parse({ enabled: true, messages, reason: REASON })).toBe(false);
  });

  it('accepts exactly 20 messages — the cap boundary', () => {
    const messages = Array.from({ length: 20 }, () => ({ variant: 'info', text: 'x' }));
    expect(parse({ enabled: true, messages, reason: REASON })).toBe(true);
  });

  it('rejects an href over 2048 characters', () => {
    const hrefOfLength = (length: number): string => {
      const base = 'https://hushbox.ai/';
      return base + 'a'.repeat(length - base.length);
    };
    expect(parse(bannerInput({ variant: 'info', text: 'x', href: hrefOfLength(2048) }))).toBe(true);
    expect(parse(bannerInput({ variant: 'info', text: 'x', href: hrefOfLength(2049) }))).toBe(
      false
    );
  });

  it('accepts a message with a valid linkText', () => {
    expect(
      parse(
        bannerInput({
          variant: 'info',
          text: 'x',
          href: 'https://hushbox.ai/blog',
          linkText: 'Read the post',
        })
      )
    ).toBe(true);
  });

  it('accepts a message without linkText', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'x' }))).toBe(true);
  });

  it('rejects whitespace-only linkText instead of silently dropping it', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'x', linkText: ' \t ' }))).toBe(false);
  });

  it('rejects linkText over 60 characters', () => {
    expect(parse(bannerInput({ variant: 'info', text: 'x', linkText: 'a'.repeat(61) }))).toBe(
      false
    );
    expect(parse(bannerInput({ variant: 'info', text: 'x', linkText: 'a'.repeat(60) }))).toBe(true);
  });

  it('rejects a missing messages field', () => {
    expect(parse({ enabled: true, reason: REASON })).toBe(false);
  });
});

describe('newsletter op inputs', () => {
  it('newsletter.schedule rejects a non-ISO scheduledAt', () => {
    const result = ADMIN_OP_CONTRACTS['newsletter.schedule'].input.safeParse({
      subject: 'x',
      bodyMarkdown: 'y',
      scheduledAt: 'tomorrow',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });

  it('newsletter.schedule rejects an empty subject and empty bodyMarkdown', () => {
    for (const patch of [{ subject: '' }, { bodyMarkdown: '' }]) {
      const result = ADMIN_OP_CONTRACTS['newsletter.schedule'].input.safeParse({
        subject: 'x',
        bodyMarkdown: 'y',
        scheduledAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        reason: REASON,
        ...patch,
      });
      expect(result.success).toBe(false);
    }
  });

  const scheduleInput = (patch: Record<string, unknown>): Record<string, unknown> => ({
    subject: 'Monthly issue',
    bodyMarkdown: '# Hello',
    scheduledAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
    reason: REASON,
    ...patch,
  });
  const scheduleAccepts = (patch: Record<string, unknown>): boolean =>
    ADMIN_OP_CONTRACTS['newsletter.schedule'].input.safeParse(scheduleInput(patch)).success;
  const testSendAccepts = (patch: Record<string, unknown>): boolean =>
    ADMIN_OP_CONTRACTS['newsletter.testSend'].input.safeParse({
      subject: 'Monthly issue',
      bodyMarkdown: '# Hello',
      reason: REASON,
      ...patch,
    }).success;

  it('newsletter.schedule accepts a subject exactly at the length cap', () => {
    expect(scheduleAccepts({ subject: 'a'.repeat(MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH) })).toBe(
      true
    );
  });

  it('newsletter.schedule rejects a subject over the length cap', () => {
    expect(scheduleAccepts({ subject: 'a'.repeat(MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH + 1) })).toBe(
      false
    );
  });

  it('newsletter.schedule accepts a bodyMarkdown exactly at the length cap', () => {
    expect(scheduleAccepts({ bodyMarkdown: 'a'.repeat(MAX_ADMIN_NEWSLETTER_BODY_LENGTH) })).toBe(
      true
    );
  });

  it('newsletter.schedule rejects a bodyMarkdown over the length cap', () => {
    expect(
      scheduleAccepts({ bodyMarkdown: 'a'.repeat(MAX_ADMIN_NEWSLETTER_BODY_LENGTH + 1) })
    ).toBe(false);
  });

  it('newsletter.schedule still accepts a realistic long-form issue', () => {
    const paragraph = `${'word '.repeat(120).trim()}\n\n`;
    expect(
      scheduleAccepts({
        subject: 'What shipped in HushBox this month, and why it matters for your privacy',
        bodyMarkdown: `# This month\n\n${paragraph.repeat(30)}`,
      })
    ).toBe(true);
  });

  it('newsletter.testSend rejects a subject over the length cap', () => {
    expect(testSendAccepts({ subject: 'a'.repeat(MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH + 1) })).toBe(
      false
    );
  });

  it('newsletter.testSend rejects a bodyMarkdown over the length cap', () => {
    expect(
      testSendAccepts({ bodyMarkdown: 'a'.repeat(MAX_ADMIN_NEWSLETTER_BODY_LENGTH + 1) })
    ).toBe(false);
  });

  it('newsletter.cancel rejects a non-uuid issueId', () => {
    const result = ADMIN_OP_CONTRACTS['newsletter.cancel'].input.safeParse({
      issueId: 'not-a-uuid',
      reason: REASON,
    });
    expect(result.success).toBe(false);
  });
});

describe('operator text caps bound the submitted value, not the trimmed one', () => {
  const PAD = ' '.repeat(100_000);
  const bannerParse = (message: Record<string, unknown>): boolean =>
    ADMIN_OP_CONTRACTS['banner.set'].input.safeParse({
      enabled: true,
      messages: [message],
      reason: REASON,
    }).success;

  it('every mutation rejects a reason padded past the cap with whitespace', () => {
    const padded = 'a'.repeat(MAX_ADMIN_REASON_LENGTH) + PAD;
    for (const name of MUTATION_OP_NAMES) {
      const contract = ADMIN_OP_CONTRACTS[name];
      expect(
        contract.input.safeParse({ ...VALID_INPUTS[name], reason: padded }).success,
        `${name} padded reason`
      ).toBe(false);
    }
  });

  it('newsletter.schedule rejects a subject padded past the cap with whitespace', () => {
    const padded = 'a'.repeat(MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH) + PAD;
    expect(
      ADMIN_OP_CONTRACTS['newsletter.schedule'].input.safeParse({
        ...VALID_INPUTS['newsletter.schedule'],
        subject: padded,
      }).success
    ).toBe(false);
  });

  it('newsletter.testSend rejects a subject padded past the cap with whitespace', () => {
    const padded = 'a'.repeat(MAX_ADMIN_NEWSLETTER_SUBJECT_LENGTH) + PAD;
    expect(
      ADMIN_OP_CONTRACTS['newsletter.testSend'].input.safeParse({
        ...VALID_INPUTS['newsletter.testSend'],
        subject: padded,
      }).success
    ).toBe(false);
  });

  it('payment ops reject a helcimTransactionId padded past the cap with whitespace', () => {
    const padded = 'a'.repeat(MAX_ADMIN_TRANSACTION_ID_LENGTH) + PAD;
    expect(
      ADMIN_OP_CONTRACTS['payment.restoreAwaitingWebhook'].input.safeParse({
        ...VALID_INPUTS['payment.restoreAwaitingWebhook'],
        helcimTransactionId: padded,
      }).success
    ).toBe(false);
  });

  it('banner.set rejects message text padded past the cap with whitespace', () => {
    const padded = 'a'.repeat(MAX_BANNER_TEXT_LENGTH) + PAD;
    expect(bannerParse({ variant: 'info', text: padded })).toBe(false);
  });

  it('banner.set rejects linkText padded past the cap with whitespace', () => {
    const padded = 'a'.repeat(MAX_BANNER_LINK_TEXT_LENGTH) + PAD;
    expect(
      bannerParse({
        variant: 'info',
        text: 'x',
        href: 'https://hushbox.ai/blog',
        linkText: padded,
      })
    ).toBe(false);
  });

  it('still trims surrounding whitespace off an in-cap reason', () => {
    const parsed = ADMIN_OP_CONTRACTS['user.unlock'].input.parse({
      ...VALID_INPUTS['user.unlock'],
      reason: `  ${REASON}  `,
    });
    expect(parsed.reason).toBe(REASON);
  });

  it('still trims surrounding whitespace off an in-cap newsletter subject', () => {
    const parsed = ADMIN_OP_CONTRACTS['newsletter.schedule'].input.parse({
      ...VALID_INPUTS['newsletter.schedule'],
      subject: '  Monthly issue  ',
    });
    expect(parsed.subject).toBe('Monthly issue');
  });

  it('still trims surrounding whitespace off in-cap banner text', () => {
    const parsed = ADMIN_OP_CONTRACTS['banner.set'].input.parse({
      enabled: true,
      messages: [{ variant: 'info', text: '  Heads up  ' }],
      reason: REASON,
    });
    expect(parsed.messages[0]?.text).toBe('Heads up');
  });

  it('still trims surrounding whitespace off an in-cap banner linkText', () => {
    const parsed = ADMIN_OP_CONTRACTS['banner.set'].input.parse({
      enabled: true,
      messages: [
        { variant: 'info', text: 'x', href: 'https://hushbox.ai/blog', linkText: '  Read more  ' },
      ],
      reason: REASON,
    });
    expect(parsed.messages[0]?.linkText).toBe('Read more');
  });
});

describe('two-factor op inputs', () => {
  const restoreAccepts = (groups: unknown): boolean =>
    ADMIN_OP_CONTRACTS['twoFactor.restoreStranded'].input.safeParse({ groups, reason: REASON })
      .success;
  const group = (patch: Record<string, unknown>): Record<string, unknown> => ({
    fingerprint: '00112233445566aa',
    count: 3,
    ...patch,
  });

  const clearAccepts = (input: Record<string, unknown>): boolean =>
    ADMIN_OP_CONTRACTS['twoFactor.clearStranded'].input.safeParse({ reason: REASON, ...input })
      .success;
  const keyId = (fingerprint: string): Record<string, unknown> => ({ fingerprint });

  it('twoFactor.clearStranded names no target beyond the reason and its key scope', () => {
    expect(Object.keys(ADMIN_OP_CONTRACTS['twoFactor.clearStranded'].input.shape)).toEqual([
      'keys',
      'reason',
    ]);
  });

  it('twoFactor.clearStranded accepts no key scope at all — that is the sweep', () => {
    expect(clearAccepts({})).toBe(true);
  });

  it('twoFactor.clearStranded accepts a scope of named retired keys', () => {
    expect(clearAccepts({ keys: [keyId('00112233445566aa'), keyId('aabbccddeeff0011')] })).toBe(
      true
    );
  });

  it('twoFactor.clearStranded rejects an empty key scope — absence is how a sweep is asked for', () => {
    expect(clearAccepts({ keys: [] })).toBe(false);
  });

  it('twoFactor.clearStranded rejects a non-hex key id in its scope', () => {
    for (const fingerprint of ['not-hex', '00112233445566AA', '0011223344556', '']) {
      expect(clearAccepts({ keys: [keyId(fingerprint)] }), fingerprint).toBe(false);
    }
  });

  it('twoFactor.clearStranded rejects a scope naming more keys than one clear may carry', () => {
    const keys = Array.from({ length: MAX_STRANDED_TOTP_GROUPS + 1 }, (_unused, index) =>
      keyId(index.toString(16).padStart(16, '0'))
    );
    expect(clearAccepts({ keys })).toBe(false);
  });

  it('twoFactor.restoreStranded accepts a recorded group', () => {
    expect(restoreAccepts([group({})])).toBe(true);
  });

  it('twoFactor.restoreStranded accepts several recorded groups — a clear can span retired keys', () => {
    expect(restoreAccepts([group({}), group({ fingerprint: 'aabbccddeeff0011', count: 1 })])).toBe(
      true
    );
  });

  it('twoFactor.restoreStranded rejects an empty group list — it would restore nothing', () => {
    expect(restoreAccepts([])).toBe(false);
  });

  it('twoFactor.restoreStranded rejects a non-hex fingerprint', () => {
    for (const fingerprint of ['not-hex', '00112233445566AA', '0011223344556', '']) {
      expect(restoreAccepts([group({ fingerprint })]), fingerprint).toBe(false);
    }
  });

  it('twoFactor.restoreStranded rejects a fingerprint over the length cap', () => {
    expect(restoreAccepts([group({ fingerprint: 'ab'.repeat(MAX_TOTP_KEY_ID_HEX_LENGTH) })])).toBe(
      false
    );
  });

  it('twoFactor.restoreStranded rejects a count the doors can never have recorded', () => {
    for (const count of [0, -1, 1.5]) {
      expect(restoreAccepts([group({ count })]), String(count)).toBe(false);
    }
  });

  it('twoFactor.restoreStranded rejects more groups than the cap', () => {
    const groups = Array.from({ length: MAX_STRANDED_TOTP_GROUPS + 1 }, () => group({}));
    expect(restoreAccepts(groups)).toBe(false);
    expect(restoreAccepts(groups.slice(1))).toBe(true);
  });

  it('the per-user pair rejects a non-uuid userId', () => {
    for (const name of ['twoFactor.clear', 'twoFactor.restore'] as const) {
      expect(
        ADMIN_OP_CONTRACTS[name].input.safeParse({ userId: 'not-a-uuid', reason: REASON }).success,
        name
      ).toBe(false);
    }
  });
});

describe('growth read contracts', () => {
  const READ_NAMES = [
    'growth.freshness.read',
    'growth.funnel.read',
    'growth.marketing.read',
    'growth.sources.read',
    'growth.campaigns.read',
    'growth.events.read',
    'growth.reach.read',
  ] as const;

  it.each(READ_NAMES)('%s admits the read-only role as well as the operator', (name) => {
    expect([...ADMIN_OP_CONTRACTS[name].allowedRoles].toSorted(byName)).toEqual([
      'growth-viewer',
      'operator',
    ]);
  });

  it.each(READ_NAMES)('%s names no target and no inverse', (name) => {
    expect(ADMIN_OP_CONTRACTS[name].target).toBeNull();
    expect(ADMIN_OP_CONTRACTS[name].inverse).toBeNull();
  });

  it.each(READ_NAMES)('%s asks for no reason — a read justifies nothing', (name) => {
    expect(Object.keys(ADMIN_OP_CONTRACTS[name].input.shape)).not.toContain('reason');
  });

  it('says in its own description what a funnel step takes, not how many steps take it', () => {
    const { description } = ADMIN_OP_CONTRACTS['growth.funnel.read'];
    expect(description).toContain('lower bound');
    expect(description).toBe(BUCKET_MAXIMUM_NOTE);
  });

  it('accepts a window and an optional campaign filter on the funnel read', () => {
    const input = ADMIN_OP_CONTRACTS['growth.funnel.read'].input;
    expect(
      input.safeParse({ from: isoAt(TEST_DAY_START), to: isoAt(TEST_DAY_START) }).success
    ).toBe(true);
    expect(
      input.safeParse({
        from: isoAt(TEST_DAY_START),
        to: isoAt(TEST_DAY_START),
        campaign: 'launch-2026',
      }).success
    ).toBe(true);
  });

  it('rejects a malformed campaign tag on the funnel read', () => {
    expect(
      ADMIN_OP_CONTRACTS['growth.funnel.read'].input.safeParse({
        from: isoAt(TEST_DAY_START),
        to: isoAt(TEST_DAY_START),
        campaign: 'Launch 2026',
      }).success
    ).toBe(false);
  });

  it('rejects a grain outside the shared two on the marketing read', () => {
    const input = ADMIN_OP_CONTRACTS['growth.marketing.read'].input;
    const window = { from: isoAt(TEST_DAY_START), to: isoAt(TEST_DAY_START) };
    expect(input.safeParse({ ...window, grain: 'hour' }).success).toBe(true);
    expect(input.safeParse({ ...window, grain: 'week' }).success).toBe(false);
  });

  it('defaults the events read to the first page and rejects a negative one', () => {
    const input = ADMIN_OP_CONTRACTS['growth.events.read'].input;
    const window = { from: isoAt(TEST_DAY_START), to: isoAt(TEST_DAY_START) };
    expect(input.parse(window)).toMatchObject({ page: 0 });
    expect(input.safeParse({ ...window, page: -1 }).success).toBe(false);
  });

  it('says in its own description that the reach figure sums each day’s own count', () => {
    expect(ADMIN_OP_CONTRACTS['growth.reach.read'].description).toContain('summed');
  });

  it('takes the window and nothing else on the reach read', () => {
    expect(Object.keys(ADMIN_OP_CONTRACTS['growth.reach.read'].input.shape)).toEqual([
      'from',
      'to',
    ]);
  });

  it('takes no input at all on the campaigns read', () => {
    expect(Object.keys(ADMIN_OP_CONTRACTS['growth.campaigns.read'].input.shape)).toEqual([]);
  });

  it('takes no input at all on the freshness read: an input could only narrow it', () => {
    expect(Object.keys(ADMIN_OP_CONTRACTS['growth.freshness.read'].input.shape)).toEqual([]);
  });
});

describe('campaign mutation contracts', () => {
  const CAMPAIGN_NAMES = ['growth.campaign.create', 'growth.campaign.archive'] as const;

  it.each(CAMPAIGN_NAMES)('%s is operator-only and targets the tag', (name) => {
    expect(ADMIN_OP_CONTRACTS[name].allowedRoles).toEqual(['operator']);
    expect(ADMIN_OP_CONTRACTS[name].target).toEqual({ type: 'campaign', field: 'tag' });
  });

  it.each(CAMPAIGN_NAMES)('%s rejects a tag the campaign pattern refuses', (name) => {
    expect(
      ADMIN_OP_CONTRACTS[name].input.safeParse({ tag: 'Launch 2026', label: 'L', reason: REASON })
        .success
    ).toBe(false);
  });

  it('refuses a blank label on the create', () => {
    const input = ADMIN_OP_CONTRACTS['growth.campaign.create'].input;
    expect(input.safeParse({ tag: 'launch-2026', label: '   ', reason: REASON }).success).toBe(
      false
    );
    expect(input.safeParse({ tag: 'launch-2026', label: 'Launch', reason: REASON }).success).toBe(
      true
    );
  });
});
