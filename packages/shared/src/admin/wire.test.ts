import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  TEST_DAY_START,
  isoAt,
  testUuidV7,
} from '../testing/test-time.ts';
import { growthDayBucket } from '../growth/bucket.ts';
import {
  adminOpExecuteResultSchema,
  adminOpReadResultSchema,
  growthCampaignsReadSchema,
  growthEventsReadSchema,
  growthFreshnessReadSchema,
  growthFreshnessWireSchema,
  growthFunnelReadSchema,
  growthReachReadSchema,
  growthMarketingReadSchema,
  growthSourcesReadSchema,
  adminOpPrefillResultSchema,
  adminOpPreviewResultSchema,
  adminOpsCatalogSchema,
  adminAuditRowWireSchema,
  dashboardWireSchema,
  adminAuditExecutedDetailsSchema,
  adminModelsWireSchema,
  customer360ViewSchema,
  jobQueueWireSchema,
  auditSearchWireSchema,
  feedbackInboxWireSchema,
  feedbackDetailWireSchema,
  newsletterIssuesWireSchema,
  newsletterSubscribersWireSchema,
  newsletterStatsWireSchema,
  sqlPanelResultWireSchema,
} from './wire.ts';

describe('adminOpsCatalogSchema', () => {
  it('parses a catalog entry with guardrails', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'wallet.credit',
          title: 'Credit wallet',
          kind: 'mutation',
          effectClass: 'durable',
          inverse: 'wallet.clawback',
          fields: ['walletId', 'amountNanoUsd', 'reason'],
          guardrails: { maxAmountNanoUsd: '1000000000000' },
        },
      ],
      role: 'operator',
    });
    expect(parsed.ops[0]?.guardrails?.maxAmountNanoUsd).toBe('1000000000000');
  });

  it('strips a rate-limit key: the money cap is the only guardrail the wire carries', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'wallet.credit',
          title: 'Credit wallet',
          kind: 'mutation',
          effectClass: 'durable',
          inverse: 'wallet.clawback',
          fields: [],
          guardrails: { maxAmountNanoUsd: '1000000000000', rateLimitKey: 'k' },
        },
      ],
      role: 'operator',
    });
    expect(parsed.ops[0]?.guardrails).toEqual({ maxAmountNanoUsd: '1000000000000' });
  });

  it('parses an ephemeral entry without guardrails and with a null inverse', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'session.revoke',
          title: 'Revoke sessions',
          kind: 'mutation',
          effectClass: 'ephemeral',
          inverse: null,
          fields: ['userId', 'reason'],
        },
      ],
      role: 'operator',
    });
    expect(parsed.ops[0]?.inverse).toBeNull();
    expect(parsed.ops[0]?.guardrails).toBeUndefined();
  });

  it('parses a system-owned entry with a null inverse', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'job.redrive',
          title: 'Redrive dead job',
          kind: 'mutation',
          effectClass: 'system-owned',
          inverse: null,
          fields: ['jobId', 'reason'],
          systemOwnedReason: 'resumes work the system already owed',
        },
      ],
      role: 'operator',
    });
    expect(parsed.ops[0]?.effectClass).toBe('system-owned');
  });

  it('carries the stated system-owned reason to the operator', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'job.redrive',
          title: 'Redrive dead job',
          kind: 'mutation',
          effectClass: 'system-owned',
          inverse: null,
          fields: ['jobId', 'reason'],
          systemOwnedReason: 'resumes work the system already owed',
        },
      ],
      role: 'operator',
    });
    expect(parsed.ops[0]?.systemOwnedReason).toBe('resumes work the system already owed');
  });

  it('leaves the reason absent on an entry of another class', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'wallet.credit',
          title: 'Credit wallet',
          kind: 'mutation',
          effectClass: 'durable',
          inverse: 'wallet.clawback',
          fields: ['walletId', 'reason'],
        },
      ],
      role: 'operator',
    });
    expect(parsed.ops[0]?.systemOwnedReason).toBeUndefined();
  });

  it('rejects an entry with a non-string name', () => {
    expect(() =>
      adminOpsCatalogSchema.parse({
        ops: [
          {
            name: 42,
            title: 'Broken',
            kind: 'mutation',
            effectClass: 'durable',
            inverse: null,
            fields: [],
          },
        ],
      })
    ).toThrow();
  });

  it('rejects a non-decimal maxAmountNanoUsd guardrail', () => {
    expect(() =>
      adminOpsCatalogSchema.parse({
        ops: [
          {
            name: 'wallet.credit',
            title: 'Credit wallet',
            kind: 'mutation',
            effectClass: 'durable',
            inverse: 'wallet.clawback',
            fields: [],
            guardrails: { maxAmountNanoUsd: '10 dollars' },
          },
        ],
      })
    ).toThrow();
  });
});

describe('adminOpPreviewResultSchema', () => {
  it('parses effects with optional before/after and a nullable inverseInput', () => {
    const parsed = adminOpPreviewResultSchema.parse({
      effects: [{ label: 'wallet.balance', before: '0', after: '5000000000' }, { label: 'flag' }],
      inverseInput: null,
    });
    expect(parsed.effects).toHaveLength(2);
    expect(parsed.inverseInput).toBeNull();
  });

  it('rejects a payload missing effects', () => {
    expect(() => adminOpPreviewResultSchema.parse({ inverseInput: null })).toThrow();
  });
});

describe('adminOpExecuteResultSchema', () => {
  it('parses the committed run result', () => {
    const parsed = adminOpExecuteResultSchema.parse({
      auditId: testUuidV7(0),
      effects: [{ label: 'user.lockedAt' }],
      inverseInput: { userId: 'u', reason: 'undo' },
    });
    expect(parsed.auditId).toBe(testUuidV7(0));
    expect(parsed.inverseInput).toEqual({ userId: 'u', reason: 'undo' });
  });

  it('rejects a non-uuid auditId', () => {
    expect(() =>
      adminOpExecuteResultSchema.parse({ auditId: 'nope', effects: [], inverseInput: null })
    ).toThrow();
  });
});

describe('adminOpPrefillResultSchema', () => {
  it('parses a banner-shaped partial input', () => {
    const parsed = adminOpPrefillResultSchema.parse({
      input: {
        enabled: true,
        messages: [
          { variant: 'info', text: 'Maintenance tonight', href: '/status', linkText: 'Details' },
        ],
      },
    });
    expect(parsed.input['enabled']).toBe(true);
    expect(parsed.input['messages']).toHaveLength(1);
  });

  it('parses an empty input record', () => {
    const parsed = adminOpPrefillResultSchema.parse({ input: {} });
    expect(parsed.input).toEqual({});
  });

  it('rejects a non-object input', () => {
    expect(() => adminOpPrefillResultSchema.parse({ input: 'enabled=true' })).toThrow();
  });

  it('rejects a payload missing the input key', () => {
    expect(() => adminOpPrefillResultSchema.parse({})).toThrow();
  });
});

const AUDIT_ROW = {
  id: testUuidV7(1),
  actor: 'founder@hushbox.test',
  role: 'operator',
  action: 'user.lock',
  targetType: 'user',
  targetId: testUuidV7(2),
  details: {
    input: { userId: 'u', lockReason: 'chargeback', reason: 'dispute' },
    effects: [{ label: 'user.lockedAt' }],
    inverseInput: { userId: 'u', reason: 'undo lock' },
  },
  undoes: null,
  undoneBy: null,
  createdAt: isoAt(TEST_DAY_START + 14 * DAY_MS),
};

describe('adminAuditRowWireSchema', () => {
  it('carries the acting role', () => {
    expect(adminAuditRowWireSchema.parse(AUDIT_ROW).role).toBe('operator');
  });

  it('rejects a row carrying no role', () => {
    const rest = Object.fromEntries(Object.entries(AUDIT_ROW).filter(([key]) => key !== 'role'));
    expect(() => adminAuditRowWireSchema.parse(rest)).toThrow();
  });

  it('rejects a role outside the admin role set', () => {
    expect(() => adminAuditRowWireSchema.parse({ ...AUDIT_ROW, role: 'founder' })).toThrow();
  });

  // The three envelopes that embed this row, asserted one by one: a field added
  // to the row reaches all of them through the single producer, and a surface
  // that dropped it would still parse if only the row itself were checked.
  it('reaches the dashboard envelope', () => {
    const parsed = dashboardWireSchema.parse({
      jobs: { pending: 0, running: 0, dead: 0, discarded: 0 },
      recentActions: [AUDIT_ROW, { ...AUDIT_ROW, id: testUuidV7(9), role: 'growth-viewer' }],
    });
    expect(parsed.recentActions.map((row) => row.role)).toEqual(['operator', 'growth-viewer']);
  });

  it("reaches the customer view's admin-history panel", () => {
    const parsed = customer360ViewSchema.parse({
      ...C360,
      panels: {
        ...C360.panels,
        adminHistory: {
          ok: true,
          data: {
            actions: [AUDIT_ROW, { ...AUDIT_ROW, id: testUuidV7(9), role: 'growth-viewer' }],
          },
        },
      },
    });
    if (!parsed.panels.adminHistory.ok) throw new Error('expected the admin-history panel ok');
    expect(parsed.panels.adminHistory.data.actions.map((row) => row.role)).toEqual([
      'operator',
      'growth-viewer',
    ]);
  });

  it('reaches the audit-search page', () => {
    const parsed = auditSearchWireSchema.parse({
      rows: [AUDIT_ROW, { ...AUDIT_ROW, id: testUuidV7(9), role: 'growth-viewer' }],
      nextCursor: null,
    });
    expect(parsed.rows.map((row) => row.role)).toEqual(['operator', 'growth-viewer']);
  });
});

describe('dashboardWireSchema', () => {
  it('parses the dashboard envelope', () => {
    const parsed = dashboardWireSchema.parse({
      jobs: { pending: 1, running: 2, dead: 3, discarded: 4 },
      recentActions: [AUDIT_ROW],
    });
    expect(parsed.jobs.dead).toBe(3);
    expect(parsed.recentActions[0]?.action).toBe('user.lock');
  });

  it('rejects a non-integer job count', () => {
    expect(() =>
      dashboardWireSchema.parse({
        jobs: { pending: 1.5, running: 0, dead: 0, discarded: 0 },
        recentActions: [],
      })
    ).toThrow();
  });

  it('rejects an audit row missing its actor', () => {
    const rest = Object.fromEntries(Object.entries(AUDIT_ROW).filter(([key]) => key !== 'actor'));
    expect(() =>
      dashboardWireSchema.parse({
        jobs: { pending: 0, running: 0, dead: 0, discarded: 0 },
        recentActions: [rest],
      })
    ).toThrow();
  });
});

describe('adminAuditExecutedDetailsSchema', () => {
  it('parses an executed-effect details payload', () => {
    const parsed = adminAuditExecutedDetailsSchema.parse(AUDIT_ROW.details);
    expect(parsed.inverseInput).toEqual({ userId: 'u', reason: 'undo lock' });
  });

  it('rejects a read-audit details payload (no effects)', () => {
    expect(() => adminAuditExecutedDetailsSchema.parse({ query: { email: 'a@b.c' } })).toThrow();
  });
});

const MONEY_PANEL = {
  balance: {
    purchasedNanoUsd: '-2500000000',
    freeNanoUsd: '0',
    allowance: {
      day: '2026-07-15',
      limitNanoUsd: '100000000',
      spentNanoUsd: '100000000',
      remainingNanoUsd: '0',
    },
  },
  wallets: [
    {
      id: testUuidV7(4),
      type: 'purchased',
      balanceNanoUsd: '-2500000000',
    },
  ],
  recentLedger: [
    {
      createdAt: isoAt(TEST_DAY_START + 4 * DAY_MS + 10 * HOUR_MS),
      kind: 'charge',
      amountNanoUsd: '-2500000000',
      balanceAfterNanoUsd: '-2500000000',
    },
  ],
};

const C360 = {
  user: {
    id: testUuidV7(2),
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
    totpEnabled: false,
    createdAt: isoAt(TEST_DAY_START),
    lockedAt: isoAt(TEST_DAY_START + 9 * DAY_MS),
    lockReason: 'chargeback',
    hasAcknowledgedPhrase: true,
  },
  panels: {
    money: { ok: true, data: MONEY_PANEL },
    usage: {
      ok: true,
      data: {
        models: [
          { modelId: 'openai/gpt-5', totalNanoUsd: '900000000', recordCount: 3, estimatedCount: 1 },
        ],
      },
    },
    conversations: { ok: true, data: { owned: 4, activeMemberships: 6 } },
    devices: {
      ok: true,
      data: { count: 2, tokens: [{ platform: 'ios' }, { platform: 'android' }] },
    },
    jobs: {
      ok: true,
      data: {
        jobs: [
          {
            id: testUuidV7(3),
            type: 'media.reclaimUser.v1',
            shard: 'bulk',
            status: 'dead',
            discarded: false,
            failures: 8,
            claims: 9,
            payload: { userId: 'u' },
            errors: [
              { at: isoAt(TEST_DAY_START + 4 * DAY_MS + 10 * HOUR_MS), claim: 9, error: 'boom' },
            ],
            nextAttemptAt: isoAt(TEST_DAY_START + 4 * DAY_MS + 11 * HOUR_MS),
            createdAt: isoAt(TEST_DAY_START + 4 * DAY_MS + 9 * HOUR_MS),
            finishedAt: null,
          },
        ],
      },
    },
    adminHistory: { ok: false, error: 'unavailable' },
  },
};

describe('customer360ViewSchema', () => {
  it('parses a full view with ok and failed panels', () => {
    const parsed = customer360ViewSchema.parse(C360);
    expect(parsed.user.email).toBe('user@example.com');
    expect(parsed.panels.money.ok).toBe(true);
    expect(parsed.panels.adminHistory).toEqual({ ok: false, error: 'unavailable' });
  });

  it('parses a negative NanoUSD balance string', () => {
    const parsed = customer360ViewSchema.parse(C360);
    if (!parsed.panels.money.ok) throw new Error('expected money panel ok');
    expect(parsed.panels.money.data.balance.purchasedNanoUsd).toBe('-2500000000');
  });

  it('rejects a malformed NanoUSD wire string', () => {
    const broken = {
      ...C360,
      panels: {
        ...C360.panels,
        money: {
          ok: true,
          data: {
            ...MONEY_PANEL,
            balance: { ...MONEY_PANEL.balance, purchasedNanoUsd: '2.5' },
          },
        },
      },
    };
    expect(() => customer360ViewSchema.parse(broken)).toThrow();
  });

  it('rejects a failed panel missing its error code', () => {
    const broken = { ...C360, panels: { ...C360.panels, adminHistory: { ok: false } } };
    expect(() => customer360ViewSchema.parse(broken)).toThrow();
  });

  it('parses an unlocked user (null lockedAt)', () => {
    const parsed = customer360ViewSchema.parse({
      ...C360,
      user: { ...C360.user, lockedAt: null },
    });
    expect(parsed.user.lockedAt).toBeNull();
  });

  it('parses the account facts the server always emits (createdAt, lockReason)', () => {
    const parsed = customer360ViewSchema.parse(C360);
    expect(parsed.user.createdAt).toBe(isoAt(TEST_DAY_START));
    expect(parsed.user.lockReason).toBe('chargeback');
  });

  it('parses wallet identity rows inside the money panel', () => {
    const parsed = customer360ViewSchema.parse(C360);
    if (!parsed.panels.money.ok) throw new Error('expected money panel ok');
    expect(parsed.panels.money.data.wallets).toEqual([
      {
        id: testUuidV7(4),
        type: 'purchased',
        balanceNanoUsd: '-2500000000',
      },
    ]);
  });

  it('parses the devices panel (platform per token, no token value)', () => {
    const parsed = customer360ViewSchema.parse(C360);
    expect(parsed.panels.devices).toEqual({
      ok: true,
      data: { count: 2, tokens: [{ platform: 'ios' }, { platform: 'android' }] },
    });
  });

  it('rejects a view missing createdAt (the server always emits it)', () => {
    const rest = Object.fromEntries(
      Object.entries(C360.user).filter(([key]) => key !== 'createdAt')
    );
    expect(() => customer360ViewSchema.parse({ ...C360, user: rest })).toThrow();
  });

  it('rejects a view missing the devices panel (the server always emits it)', () => {
    const panels = Object.fromEntries(
      Object.entries(C360.panels).filter(([key]) => key !== 'devices')
    );
    expect(() => customer360ViewSchema.parse({ ...C360, panels })).toThrow();
  });

  it('rejects a money panel missing wallet identity rows', () => {
    const moneyWithoutWallets = Object.fromEntries(
      Object.entries(MONEY_PANEL).filter(([key]) => key !== 'wallets')
    );
    expect(() =>
      customer360ViewSchema.parse({
        ...C360,
        panels: { ...C360.panels, money: { ok: true, data: moneyWithoutWallets } },
      })
    ).toThrow();
  });
});

const MODEL_ROW = {
  modelId: 'openai/gpt-5',
  name: 'GPT-5',
  family: 'language',
  zdrReachable: true,
  adminDisabledAt: null,
};

describe('adminModelsWireSchema', () => {
  it('parses the catalog page with disabled and null-projection rows', () => {
    const parsed = adminModelsWireSchema.parse({
      models: [
        MODEL_ROW,
        {
          modelId: 'broken/descriptor',
          name: null,
          family: null,
          zdrReachable: null,
          adminDisabledAt: isoAt(TEST_DAY_START + 3 * DAY_MS + 12 * HOUR_MS),
        },
      ],
      truncated: false,
    });
    expect(parsed.models[0]?.family).toBe('language');
    expect(parsed.models[1]?.adminDisabledAt).toBe(
      isoAt(TEST_DAY_START + 3 * DAY_MS + 12 * HOUR_MS)
    );
    expect(parsed.truncated).toBe(false);
  });

  it('parses a truncated page (server cut at the model cap)', () => {
    const parsed = adminModelsWireSchema.parse({ models: [], truncated: true });
    expect(parsed.truncated).toBe(true);
  });

  it('rejects a family outside the call-shape set', () => {
    expect(() =>
      adminModelsWireSchema.parse({
        models: [{ ...MODEL_ROW, family: 'audio' }],
        truncated: false,
      })
    ).toThrow();
  });

  it('rejects a page missing the truncation flag', () => {
    expect(() => adminModelsWireSchema.parse({ models: [MODEL_ROW] })).toThrow();
  });
});

const JOB_ROW = {
  id: testUuidV7(0xa),
  type: 'media.reclaimUser.v1',
  shard: 'bulk',
  status: 'dead',
  discarded: false,
  failures: 8,
  claims: 9,
  payload: { userId: testUuidV7(1) },
  errors: [
    {
      at: isoAt(TEST_DAY_START + 4 * DAY_MS + 10 * HOUR_MS),
      claim: 1,
      error: 'storage unavailable',
    },
  ],
  nextAttemptAt: isoAt(TEST_DAY_START + 4 * DAY_MS + 11 * HOUR_MS),
  createdAt: isoAt(TEST_DAY_START + 4 * DAY_MS + 9 * HOUR_MS),
  finishedAt: null,
};

describe('jobQueueWireSchema', () => {
  it('parses a cursor page of job rows', () => {
    const parsed = jobQueueWireSchema.parse({
      rows: [JOB_ROW],
      nextCursor: testUuidV7(0xb),
    });
    expect(parsed.rows[0]?.type).toBe('media.reclaimUser.v1');
    expect(parsed.nextCursor).toBe(testUuidV7(0xb));
  });

  it('parses the last page with a null cursor', () => {
    const parsed = jobQueueWireSchema.parse({ rows: [], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
  });

  it('rejects a page whose rows drift from the job row shape', () => {
    expect(() =>
      jobQueueWireSchema.parse({ rows: [{ ...JOB_ROW, failures: 'many' }], nextCursor: null })
    ).toThrow();
  });
});

describe('auditSearchWireSchema', () => {
  const AUDIT_ROW = {
    id: testUuidV7(0xc),
    actor: 'ops@hushbox.test',
    role: 'growth-viewer',
    action: 'job.discard',
    targetType: 'job',
    targetId: testUuidV7(0xa),
    details: { input: { reason: 'superseded' }, effects: [], inverseInput: null },
    undoes: null,
    undoneBy: null,
    createdAt: isoAt(TEST_DAY_START + 4 * DAY_MS + 10 * HOUR_MS),
  };

  it('parses a cursor page of threaded audit rows', () => {
    const parsed = auditSearchWireSchema.parse({ rows: [AUDIT_ROW], nextCursor: null });
    expect(parsed.rows[0]?.action).toBe('job.discard');
    expect(parsed.nextCursor).toBeNull();
  });

  it('rejects a page missing the cursor field', () => {
    expect(() => auditSearchWireSchema.parse({ rows: [AUDIT_ROW] })).toThrow();
  });
});

const FEEDBACK_INBOX_ROW = {
  id: testUuidV7(0xd),
  kind: 'bug',
  status: 'new',
  bodyPreview: 'It crashed on save.',
  createdAt: isoAt(TEST_DAY_START + 14 * DAY_MS),
  userId: testUuidV7(2),
};

describe('feedbackInboxWireSchema', () => {
  it('parses a cursor page of inbox rows', () => {
    const parsed = feedbackInboxWireSchema.parse({
      rows: [FEEDBACK_INBOX_ROW],
      nextCursor: testUuidV7(0xe),
    });
    expect(parsed.rows[0]?.kind).toBe('bug');
    expect(parsed.nextCursor).toBe(testUuidV7(0xe));
  });

  it('parses the last page with a null cursor', () => {
    const parsed = feedbackInboxWireSchema.parse({ rows: [], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
  });

  it('rejects a row with a status outside the feedback set', () => {
    expect(() =>
      feedbackInboxWireSchema.parse({
        rows: [{ ...FEEDBACK_INBOX_ROW, status: 'archived' }],
        nextCursor: null,
      })
    ).toThrow();
  });

  it('rejects a page missing the cursor field', () => {
    expect(() => feedbackInboxWireSchema.parse({ rows: [FEEDBACK_INBOX_ROW] })).toThrow();
  });
});

describe('feedbackDetailWireSchema', () => {
  it('parses a full feedback detail with its body', () => {
    const parsed = feedbackDetailWireSchema.parse({
      id: testUuidV7(0xd),
      kind: 'idea',
      status: 'triaged',
      body: 'Add a dark mode toggle to settings.',
      createdAt: isoAt(TEST_DAY_START + 14 * DAY_MS),
      userId: testUuidV7(2),
    });
    expect(parsed.body).toBe('Add a dark mode toggle to settings.');
    expect(parsed.status).toBe('triaged');
  });

  it('rejects a detail with a kind outside the feedback set', () => {
    expect(() =>
      feedbackDetailWireSchema.parse({
        id: testUuidV7(0xd),
        kind: 'complaint',
        status: 'new',
        body: 'x',
        createdAt: isoAt(TEST_DAY_START + 14 * DAY_MS),
        userId: testUuidV7(2),
      })
    ).toThrow();
  });
});

describe('sqlPanelResultWireSchema', () => {
  it('parses a result page with heterogeneous row values', () => {
    const parsed = sqlPanelResultWireSchema.parse({
      rows: [{ id: 'a', failures: 3, finished_at: null }],
      rowCount: 1,
      truncated: false,
    });
    expect(parsed.rows[0]?.['failures']).toBe(3);
    expect(parsed.truncated).toBe(false);
  });

  it('parses a truncated page (server cut at the row cap)', () => {
    const parsed = sqlPanelResultWireSchema.parse({ rows: [], rowCount: 200, truncated: true });
    expect(parsed.truncated).toBe(true);
  });

  it('rejects a result missing the truncation flag', () => {
    expect(() => sqlPanelResultWireSchema.parse({ rows: [], rowCount: 0 })).toThrow();
  });
});

const NEWSLETTER_ISSUE_ROW = {
  id: testUuidV7(0xf),
  subject: 'July product notes',
  status: 'scheduled',
  scheduledAt: isoAt(TEST_DAY_START + 10 * DAY_MS + 9 * HOUR_MS),
  canceledAt: null,
  sentAt: null,
  recipientCount: null,
  sentCount: null,
  failedCount: null,
  createdBy: 'admin@example.com',
  createdAt: isoAt(TEST_DAY_START + 7 * DAY_MS + 9 * HOUR_MS),
};

describe('newsletterIssuesWireSchema', () => {
  it('parses a cursor page of issue rows', () => {
    const parsed = newsletterIssuesWireSchema.parse({
      rows: [NEWSLETTER_ISSUE_ROW],
      nextCursor: testUuidV7(0x10),
    });
    expect(parsed.rows[0]?.status).toBe('scheduled');
    expect(parsed.nextCursor).toBe(testUuidV7(0x10));
  });

  it('parses the last page with a null cursor', () => {
    const parsed = newsletterIssuesWireSchema.parse({ rows: [], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
  });

  it('rejects a row with a status outside the issue set', () => {
    expect(() =>
      newsletterIssuesWireSchema.parse({
        rows: [{ ...NEWSLETTER_ISSUE_ROW, status: 'draft' }],
        nextCursor: null,
      })
    ).toThrow();
  });

  it('rejects a page missing the cursor field', () => {
    expect(() => newsletterIssuesWireSchema.parse({ rows: [NEWSLETTER_ISSUE_ROW] })).toThrow();
  });
});

const NEWSLETTER_SUBSCRIBER_ROW = {
  id: testUuidV7(0x11),
  email: 'reader@example.com',
  status: 'subscribed',
  suppressReason: null,
  consentSource: 'marketing_site',
  consentIp: '203.0.113.9',
  consentTextVersion: '2026-07-17',
  createdAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
  confirmedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS + 5 * MINUTE_MS),
  unsubscribedAt: null,
  suppressedAt: null,
};

describe('newsletterSubscribersWireSchema', () => {
  it('parses a cursor page of consent-evidence rows', () => {
    const parsed = newsletterSubscribersWireSchema.parse({
      rows: [NEWSLETTER_SUBSCRIBER_ROW],
      nextCursor: null,
    });
    expect(parsed.rows[0]?.consentSource).toBe('marketing_site');
    expect(parsed.nextCursor).toBeNull();
  });

  it('parses a suppressed row with its reason', () => {
    const parsed = newsletterSubscribersWireSchema.parse({
      rows: [
        {
          ...NEWSLETTER_SUBSCRIBER_ROW,
          status: 'suppressed',
          suppressReason: 'bounce',
          suppressedAt: isoAt(TEST_DAY_START + DAY_MS + 9 * HOUR_MS),
        },
      ],
      nextCursor: null,
    });
    expect(parsed.rows[0]?.suppressReason).toBe('bounce');
  });

  it('rejects a row with a suppress reason outside the set', () => {
    expect(() =>
      newsletterSubscribersWireSchema.parse({
        rows: [{ ...NEWSLETTER_SUBSCRIBER_ROW, suppressReason: 'manual' }],
        nextCursor: null,
      })
    ).toThrow();
  });

  it('rejects a row with a consent source outside the set', () => {
    expect(() =>
      newsletterSubscribersWireSchema.parse({
        rows: [{ ...NEWSLETTER_SUBSCRIBER_ROW, consentSource: 'import' }],
        nextCursor: null,
      })
    ).toThrow();
  });
});

describe('newsletterStatsWireSchema', () => {
  it('parses exhaustive per-status and per-suppress-reason counts', () => {
    const parsed = newsletterStatsWireSchema.parse({
      byStatus: { pending: 2, subscribed: 40, unsubscribed: 3, suppressed: 1 },
      bySuppressReason: { bounce: 1, complaint: 0 },
    });
    expect(parsed.byStatus.subscribed).toBe(40);
    expect(parsed.bySuppressReason.complaint).toBe(0);
  });

  it('rejects counts missing a status key', () => {
    expect(() =>
      newsletterStatsWireSchema.parse({
        byStatus: { pending: 2 },
        bySuppressReason: { bounce: 1, complaint: 0 },
      })
    ).toThrow();
  });
});

describe('adminOpReadResultSchema', () => {
  it('parses a read run: its read-audit row id and the read’s own payload', () => {
    const parsed = adminOpReadResultSchema.parse({
      kind: 'read',
      auditId: testUuidV7(7),
      data: { panels: {} },
    });

    expect(parsed.kind).toBe('read');
    expect(parsed.auditId).toBe(testUuidV7(7));
  });

  it('rejects a body carrying an execute result’s shape', () => {
    expect(() =>
      adminOpReadResultSchema.parse({ auditId: testUuidV7(7), effects: [], inverseInput: null })
    ).toThrow();
  });

  it('rejects a kind other than read, so a mutation result can never parse as one', () => {
    expect(() =>
      adminOpReadResultSchema.parse({ kind: 'mutation', auditId: testUuidV7(7), data: {} })
    ).toThrow();
  });
});

describe('growth read payloads', () => {
  const week = isoAt(TEST_DAY_START);

  it('parses a funnel panel that loaded', () => {
    const parsed = growthFunnelReadSchema.parse({
      panels: {
        funnel: {
          ok: true,
          data: {
            weeks: [
              {
                week,
                campaign: 'launch-2026',
                visitorsDailySummed: 12,
                visitorsOverflow: false,
                productEntryClicksHourlySummed: 3,
                productEntryClicksOverflow: true,
                started: 2,
                startedOverflow: false,
                finished: 1,
                verified: 1,
                activated: 1,
                returnedWeek1: 0,
                firstPaid: 0,
                revenueNanoUsd: '0',
              },
            ],
          },
        },
      },
    });

    expect(parsed.panels.funnel.ok).toBe(true);
  });

  it('refuses a funnel week that states no ceiling flag for a step that can be capped', () => {
    const complete: Record<string, unknown> = {
      week,
      campaign: 'launch-2026',
      visitorsDailySummed: 12,
      visitorsOverflow: false,
      productEntryClicksHourlySummed: 3,
      productEntryClicksOverflow: false,
      started: 2,
      startedOverflow: true,
      finished: 1,
      verified: 1,
      activated: 1,
      returnedWeek1: 0,
      firstPaid: 0,
      revenueNanoUsd: '0',
    };
    const withoutFlag = (flag: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(complete).filter(([key]) => key !== flag));
    const parse = (weeks: readonly unknown[]): boolean =>
      growthFunnelReadSchema.safeParse({ panels: { funnel: { ok: true, data: { weeks } } } })
        .success;

    expect(parse([complete])).toBe(true);
    // Every flag the payload carries, derived from the payload itself, so a step
    // that gains one is covered without this test being edited to name it.
    for (const flag of Object.keys(complete).filter((key) => key.endsWith('Overflow'))) {
      expect(parse([withoutFlag(flag)])).toBe(false);
    }
  });

  it('parses a funnel panel that failed on its own error code', () => {
    const parsed = growthFunnelReadSchema.parse({
      panels: { funnel: { ok: false, error: 'unavailable' } },
    });

    expect(parsed.panels.funnel).toEqual({ ok: false, error: 'unavailable' });
  });

  it('parses a marketing panel carrying one family’s marginal', () => {
    const parsed = growthMarketingReadSchema.parse({
      panels: {
        marketing: {
          ok: true,
          data: {
            grain: 'day',
            rows: [
              {
                bucket: week,
                family: 'paths',
                path: '/welcome',
                referrerHost: null,
                campaign: null,
                country: null,
                region: null,
                device: null,
                visitors: 4,
                landings: 2,
                overflow: false,
              },
            ],
          },
        },
      },
    });

    expect(parsed.panels.marketing.ok).toBe(true);
  });

  it('parses source counts, which carry no identifier', () => {
    const parsed = growthSourcesReadSchema.parse({
      panels: {
        sources: {
          ok: true,
          data: {
            rows: [
              {
                userCreatedWeek: week,
                campaign: 'direct',
                selfReportedChannel: 'podcast',
                selfReportedContext: 'post_signup',
                primarySource: 'podcast',
                accounts: 3,
              },
            ],
          },
        },
      },
    });

    expect(parsed.panels.sources.ok).toBe(true);
  });

  it('parses the campaign list, archived rows included', () => {
    const parsed = growthCampaignsReadSchema.parse({
      panels: {
        campaigns: {
          ok: true,
          data: {
            rows: [{ tag: 'launch-2026', label: 'Launch', status: 'archived', createdAt: week }],
          },
        },
      },
    });

    expect(parsed.panels.campaigns.ok).toBe(true);
  });

  it('parses the landing→reached pairs, each figure a sum of daily counts', () => {
    const parsed = growthReachReadSchema.parse({
      panels: {
        reach: {
          ok: true,
          data: {
            rows: [
              {
                landingPath: '/welcome',
                reachedPath: '/pricing',
                visitorsDailySummed: 402,
                overflow: false,
              },
            ],
          },
        },
      },
    });

    expect(parsed.panels.reach.ok && parsed.panels.reach.data.rows[0]?.reachedPath).toBe(
      '/pricing'
    );
  });

  it('refuses a landing→reached pair that says nothing about whether its figure is a floor', () => {
    const withoutTheMark = growthReachReadSchema.safeParse({
      panels: {
        reach: {
          ok: true,
          data: {
            rows: [{ landingPath: '/welcome', reachedPath: '/pricing', visitorsDailySummed: 402 }],
          },
        },
      },
    });

    expect(withoutTheMark.success).toBe(false);
  });

  it('parses one page of named events and says whether more follow', () => {
    const parsed = growthEventsReadSchema.parse({
      panels: {
        events: {
          ok: true,
          data: {
            page: 0,
            pageSize: 200,
            hasMore: true,
            rows: [
              {
                hour: week,
                campaign: 'direct',
                eventName: 'link:/signup',
                path: '/welcome',
                visitors: 9,
                overflow: false,
              },
            ],
          },
        },
      },
    });

    expect(parsed.panels.events.ok && parsed.panels.events.data.hasMore).toBe(true);
  });
});

describe('growth freshness payload', () => {
  const day = growthDayBucket(new Date(TEST_DAY_START));
  const weekOpening = { grain: 'week', weekOpening: day } as const;
  const runsThrough = { grain: 'day', runsThrough: day } as const;

  it('parses a newest day for every data set', () => {
    const parsed = growthFreshnessReadSchema.parse({
      panels: {
        freshness: {
          ok: true,
          data: {
            funnel: weekOpening,
            sources: weekOpening,
            marketing: runsThrough,
            events: runsThrough,
          },
        },
      },
    });

    expect(parsed.panels.freshness.ok && parsed.panels.freshness.data.marketing).toEqual(
      runsThrough
    );
  });

  it('carries no day for a data set holding nothing', () => {
    const parsed = growthFreshnessReadSchema.parse({
      panels: {
        freshness: {
          ok: true,
          data: { funnel: weekOpening, sources: null, marketing: null, events: null },
        },
      },
    });

    expect(parsed.panels.freshness.ok && parsed.panels.freshness.data.sources).toBeNull();
  });

  it('refuses an instant where a day belongs', () => {
    const withAnInstant = growthFreshnessReadSchema.safeParse({
      panels: {
        freshness: {
          ok: true,
          data: {
            funnel: { grain: 'week', weekOpening: isoAt(TEST_DAY_START) },
            sources: weekOpening,
            marketing: runsThrough,
            events: runsThrough,
          },
        },
      },
    });

    expect(withAnInstant.success).toBe(false);
  });

  it('refuses an answer that leaves a data set out', () => {
    const missingASet = growthFreshnessReadSchema.safeParse({
      panels: {
        freshness: {
          ok: true,
          data: { funnel: weekOpening, sources: weekOpening, marketing: runsThrough },
        },
      },
    });

    expect(missingASet.success).toBe(false);
  });

  it('refuses a day carrying no grain at all', () => {
    const untagged = growthFreshnessReadSchema.safeParse({
      panels: {
        freshness: {
          ok: true,
          data: { funnel: day, sources: day, marketing: day, events: day },
        },
      },
    });

    expect(untagged.success).toBe(false);
  });

  it('refuses a week-grouped value holding the day its data runs through', () => {
    const mislabelled = growthFreshnessReadSchema.safeParse({
      panels: {
        freshness: {
          ok: true,
          data: {
            funnel: { grain: 'week', runsThrough: day },
            sources: weekOpening,
            marketing: runsThrough,
            events: runsThrough,
          },
        },
      },
    });

    expect(mislabelled.success).toBe(false);
  });

  it('refuses at the compiler a reader taking a week opening for a through-day', () => {
    const data = growthFreshnessWireSchema.parse({
      funnel: weekOpening,
      sources: weekOpening,
      marketing: runsThrough,
      events: runsThrough,
    });

    // @ts-expect-error -- a value not yet narrowed on its grain carries neither day,
    // so reading either one is the mistake this shape exists to refuse.
    const throughDay: unknown = data.funnel?.runsThrough;
    // @ts-expect-error -- and it is refused in both directions.
    const opening: unknown = data.marketing?.weekOpening;

    expect([throughDay, opening]).toEqual([undefined, undefined]);
  });
});
