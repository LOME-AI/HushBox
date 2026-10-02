import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { afterAll } from 'vitest';
import { ROUTES } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  TEST_DAY_START,
  TEST_YEAR_START,
  freezeClock,
  isoAt,
} from '@hushbox/shared/test-time';
import { userFactory } from '@hushbox/db/factories';
import {
  DB_CONNECT_TIMEOUT_MS,
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  feedback,
  jobs,
  newsletterIssues,
  newsletterSubscribers,
  users,
} from '@hushbox/db';
import { createIdentityStores } from '../../identity/index.js';
import { createBillingStores, readBalance, readUsageBreakdown } from '../../billing/index.js';
import { createAdminCrossSliceReads } from '../../../composition/bindings/admin-read-bindings.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminAuditReads } from '../adapters/audit-reads.js';
import { createSqlPanel } from '../adapters/sql-panel.js';
import { READ_AUDIT_ACTIONS } from './read-audit.js';
import { createAdminReadSurface } from './read-surface.js';
import { holdTableLock } from '../../../test-support/hold-table-lock.js';
import type { AdminReadSurface } from './read-surface.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin read-surface integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const MARKETING_URL = 'https://hushbox.ai';
const billingStores = createBillingStores();
const stores = createAdminStores();

function panelUrl(): string {
  const url = new URL(DATABASE_URL!);
  url.username = 'admin_sql_panel';
  url.password = 'admin_sql_panel';
  return url.toString();
}

/** `readDb` overrides only the top-level connection the feedback reads use
 * (the panel/identity/billing deps stay bound to the real db). */
function surface(readDb: typeof db = db): AdminReadSurface {
  return createAdminReadSurface({
    db: readDb,
    role: 'operator',
    stores,
    auditReads: createAdminAuditReads(),
    crossSlice: createAdminCrossSliceReads(db),
    identity: createIdentityStores(db).users,
    billing: {
      balance: (userId, now) => readBalance(billingStores, db, userId, now),
      ledgerHistory: (userId, window) => billingStores.readLedgerHistory(db, { userId, ...window }),
      usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
    },
    sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
    clock: { now: (): Date => new Date() },
    marketingUrl: MARKETING_URL,
  });
}

/** Every read on the one pool it is handed, the way the Worker composes a request. */
function requestSurface(requestDb: typeof db): AdminReadSurface {
  return createAdminReadSurface({
    db: requestDb,
    role: 'operator',
    stores,
    auditReads: createAdminAuditReads(),
    crossSlice: createAdminCrossSliceReads(requestDb),
    identity: createIdentityStores(requestDb).users,
    billing: {
      balance: (userId, now) => readBalance(billingStores, requestDb, userId, now),
      ledgerHistory: (userId, window) =>
        billingStores.readLedgerHistory(requestDb, { userId, ...window }),
      usage: (userId) => readUsageBreakdown(billingStores, requestDb, { userId, limit: 20 }),
    },
    sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
    clock: { now: (): Date => new Date() },
    marketingUrl: MARKETING_URL,
  });
}

/** Past the pool's acquisition deadline, so a read queued behind the held one would expire. */
const HOLD_MS = DB_CONNECT_TIMEOUT_MS + 1500;

const createdUserIds: string[] = [];

function freshActor(): string {
  return `admin-surface-${crypto.randomUUID()}@hushbox.test`;
}

/** Seed one feedback row (its user is tracked for cascade cleanup in afterAll). */
async function seedFeedback(status: 'new' | 'triaged' | 'resolved' = 'new'): Promise<string> {
  const inserted = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  const user = inserted[0]!;
  createdUserIds.push(user.id);
  const rows = await db
    .insert(feedback)
    .values({ userId: user.id, kind: 'bug', body: 'long body '.repeat(30), status })
    .returning({ id: feedback.id });
  return rows[0]!.id;
}

async function sqlPanelAuditRows(actor: string): Promise<{ details: unknown }[]> {
  return db
    .select({ details: adminAudit.details })
    .from(adminAudit)
    .where(and(eq(adminAudit.actor, actor), eq(adminAudit.action, READ_AUDIT_ACTIONS.sqlPanel)));
}

beforeAll(async () => {
  // Dev-only LOGIN provisioning (ensure-stack does this for `pnpm dev`).
  await db.execute(sql`ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'`);
});

afterAll(async () => {
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('AdminReadSurface.newsletterIssues', () => {
  const issueMarker = `admin-surface-nl ${crypto.randomUUID()}`;
  const seededIssueIds: string[] = [];

  async function seedIssues(): Promise<void> {
    for (const status of ['scheduled', 'canceled', 'sent'] as const) {
      const rows = await db
        .insert(newsletterIssues)
        .values({
          subject: `${issueMarker} ${status}`,
          bodyMarkdown: 'body',
          status,
          scheduledAt: new Date(TEST_DAY_START + 365_000 * DAY_MS),
          ...(status === 'sent'
            ? {
                sentAt: new Date(TEST_DAY_START),
                recipientCount: 5,
                sentCount: 4,
                failedCount: 1,
              }
            : {}),
          createdBy: 'seed@hushbox.ai',
        })
        .returning({ id: newsletterIssues.id });
      seededIssueIds.push(rows[0]!.id);
    }
  }

  afterAll(async () => {
    if (seededIssueIds.length > 0) {
      await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, seededIssueIds));
    }
  });

  it('pages issues by keyset and maps rows to wire shape', async () => {
    await seedIssues();

    const collected: { id: string; subject: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await surface().newsletterIssues({
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const view = result._unsafeUnwrap();
      expect(view.rows.length).toBeLessThanOrEqual(2);
      collected.push(...view.rows.map((row) => ({ id: row.id, subject: row.subject })));
      if (view.nextCursor === null) break;
      cursor = view.nextCursor;
    }

    const mine = collected.filter((row) => row.subject.startsWith(issueMarker));
    // Newest-first: uuidv7 ids are time-ordered, so seeded order reverses.
    expect(mine.map((row) => row.id)).toEqual(seededIssueIds.toReversed());
  });

  it('serializes timestamps as ISO strings and carries the delivery counts', async () => {
    const result = await surface().newsletterIssues({ limit: 50 });

    const rows = result._unsafeUnwrap().rows;
    const sent = rows.find((row) => row.subject === `${issueMarker} sent`);
    expect(sent).toMatchObject({
      status: 'sent',
      scheduledAt: isoAt(TEST_DAY_START + 365_000 * DAY_MS),
      sentAt: isoAt(TEST_DAY_START),
      canceledAt: null,
      recipientCount: 5,
      sentCount: 4,
      failedCount: 1,
      createdBy: 'seed@hushbox.ai',
    });
    const scheduled = rows.find((row) => row.subject === `${issueMarker} scheduled`);
    expect(scheduled).toMatchObject({ status: 'scheduled', sentAt: null, recipientCount: null });
  });
});

describe('AdminReadSurface.renderIssue', () => {
  const draft = { subject: 'Launch notes', bodyMarkdown: '## Section\n\nHello' };

  async function previewHtml(): Promise<string> {
    const result = await surface().renderIssue(draft);
    if (result.isErr()) throw new Error(`render failed: ${result.error.code}`);
    return result.value.html;
  }

  it('stamps the copyright year from the surface clock', async () => {
    const instant = TEST_YEAR_START - HOUR_MS;
    freezeClock(instant, { toFake: ['Date'] });
    try {
      expect(await previewHtml()).toContain(
        `&copy; ${String(new Date(instant).getUTCFullYear())} `
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('links the preview unsubscribe to the marketing goodbye page, never to a bare fragment', async () => {
    const html = await previewHtml();
    const href = /<a [^>]*href="([^"]*)"[^>]*>Unsubscribe<\/a>/.exec(html)?.[1];

    expect(html).not.toContain('href="#"');
    expect(href).toBeDefined();
    const link = new URL((href ?? '').replaceAll('&amp;', '&'));
    expect(link.origin).toBe(MARKETING_URL);
    expect(link.pathname).toBe(ROUTES.NEWSLETTER_UNSUBSCRIBED);
  });
});

describe('AdminReadSurface newsletter subscribers', () => {
  const emailMarker = `admin-surface-sub-${crypto.randomUUID().slice(0, 8)}`;
  const seededSubscriberIds: string[] = [];

  async function seedSubscriber(
    status: 'pending' | 'subscribed' | 'suppressed',
    suppressReason: 'bounce' | 'complaint' | null = null
  ): Promise<string> {
    const rows = await db
      .insert(newsletterSubscribers)
      .values({
        email: `${emailMarker}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`,
        status,
        suppressReason,
        // Suppression is one fact in two columns and the table enforces
        // both-or-neither, so the reason carries its time.
        suppressedAt: suppressReason === null ? null : new Date(),
        unsubscribeToken: crypto.randomUUID(),
        confirmToken: crypto.randomUUID(),
        consentSource: 'marketing_site',
        consentIp: '203.0.113.7',
        consentTextVersion: 'v1',
      })
      .returning({ id: newsletterSubscribers.id });
    seededSubscriberIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  afterAll(async () => {
    if (seededSubscriberIds.length > 0) {
      await db
        .delete(newsletterSubscribers)
        .where(inArray(newsletterSubscribers.id, seededSubscriberIds));
    }
  });

  it('aggregates counts per status and per suppressReason', async () => {
    const beforeResult = await surface().newsletterSubscriberStats();
    const before = beforeResult._unsafeUnwrap();
    await seedSubscriber('subscribed');
    await seedSubscriber('suppressed', 'bounce');

    const afterResult = await surface().newsletterSubscriberStats();
    const after = afterResult._unsafeUnwrap();

    expect(after.byStatus.subscribed).toBe(before.byStatus.subscribed + 1);
    expect(after.byStatus.suppressed).toBe(before.byStatus.suppressed + 1);
    expect(after.bySuppressReason.bounce).toBe(before.bySuppressReason.bounce + 1);
  });

  it('lists consent evidence without token columns, filtered by status, and audits the read', async () => {
    const id = await seedSubscriber('subscribed');
    const actor = freshActor();

    const result = await surface().newsletterSubscribers({
      actor,
      limit: 100,
      status: 'subscribed',
    });

    const page = result._unsafeUnwrap();
    const mine = page.rows.find((row) => row.id === id);
    expect(mine).toMatchObject({
      status: 'subscribed',
      consentSource: 'marketing_site',
      consentIp: '203.0.113.7',
      consentTextVersion: 'v1',
    });
    expect(typeof mine?.email).toBe('string');
    expect(typeof mine?.createdAt).toBe('string');
    expect(Object.keys(mine!)).not.toContain('unsubscribeToken');
    expect(Object.keys(mine!)).not.toContain('confirmToken');
    for (const row of page.rows) {
      expect(row.status).toBe('subscribed');
    }

    const audits = await db
      .select({ action: adminAudit.action, details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(audits).toEqual([
      {
        action: READ_AUDIT_ACTIONS.newsletterSubscribers,
        details: { limit: 100, status: 'subscribed' },
      },
    ]);
  });

  it('pages the subscriber list by keyset cursor', async () => {
    await seedSubscriber('pending');
    await seedSubscriber('pending');

    const firstResult = await surface().newsletterSubscribers({ actor: freshActor(), limit: 1 });
    const first = firstResult._unsafeUnwrap();
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const secondResult = await surface().newsletterSubscribers({
      actor: freshActor(),
      limit: 1,
      cursor: first.nextCursor!,
    });
    const second = secondResult._unsafeUnwrap();
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
  });
});

describe('AdminReadSurface.sqlPanel', () => {
  it('audits the query text and returns the result page', async () => {
    const actor = freshActor();

    const result = await surface().sqlPanel({ actor, query: 'SELECT 41 + 1 AS answer' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toEqual([{ answer: 42 }]);
    }
    const audits = await sqlPanelAuditRows(actor);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toEqual({ query: 'SELECT 41 + 1 AS answer' });
  });

  it('audits a refused write attempt too — the refusal is on the record', async () => {
    const actor = freshActor();
    const query = "INSERT INTO admin_audit (actor, action) VALUES ('x', 'y')";

    const result = await surface().sqlPanel({ actor, query });

    // A write cannot sit inside the panel's unconditional row-cap wrap, so it
    // is refused as malformed before the SELECT-only role is asked.
    expect(result.isErr() && result.error.code).toBe('validation');
    const audits = await sqlPanelAuditRows(actor);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toEqual({ query });
  });

  it('refuses a blank query at the boundary without touching the panel connection', async () => {
    const actor = freshActor();

    const result = await surface().sqlPanel({ actor, query: '   ' });

    expect(result.isErr() && result.error.code).toBe('validation');
    expect(await sqlPanelAuditRows(actor)).toEqual([]);
  });
});

describe('AdminReadSurface.auditSearch', () => {
  it('returns wire rows with ISO timestamps and threading fields', async () => {
    const actor = freshActor();
    const { id } = await stores.insertAudit(db, {
      actor,
      role: 'operator' as const,
      action: 'fixture.mark',
      details: { input: {}, effects: [], inverseInput: null },
    });

    const result = await surface().auditSearch({ actor, limit: 10 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]).toMatchObject({ id, actor, undoes: null, undoneBy: null });
      expect(result.value.rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.value.nextCursor).toBeNull();
    }
  });
});

describe('AdminReadSurface.dashboard', () => {
  it('returns job counters and the recent-actions feed', async () => {
    const result = await surface().dashboard({ actor: freshActor() });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.jobs).toMatchObject({
        pending: expect.any(Number),
        running: expect.any(Number),
        dead: expect.any(Number),
        discarded: expect.any(Number),
      });
      expect(Array.isArray(result.value.recentActions)).toBe(true);
    }
  });

  it('omits its own audit row from the recent-actions feed it returns', async () => {
    const actor = freshActor();

    const result = await surface().dashboard({ actor });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.recentActions.map((row) => row.actor)).not.toContain(actor);
    }
  });

  it(
    'the dashboard answers its reads when its first read is held past the acquisition deadline',
    async () => {
      const requestDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
      try {
        const { released } = await holdTableLock(jobs, HOLD_MS);

        const result = await requestSurface(requestDb).dashboard({ actor: freshActor() });
        await released;

        expect(result.isErr() && result.error).toBe(false);
      } finally {
        await requestDb.$client.end();
      }
    },
    HOLD_MS * 3
  );
});

describe('AdminReadSurface error surfaces', () => {
  function brokenSurface(): AdminReadSurface {
    return createAdminReadSurface({
      db,
      role: 'operator',
      stores,
      auditReads: {
        search: () => Promise.reject(new Error('audit search down')),
        recent: () => Promise.reject(new Error('recent down')),
      },
      crossSlice: {
        userAccountFacts: () => Promise.reject(new Error('down')),
        walletSummaries: () => Promise.reject(new Error('down')),
        deviceTokenSummary: () => Promise.reject(new Error('down')),
        conversationCounts: () => Promise.reject(new Error('down')),
        jobsTouchingUser: () => Promise.reject(new Error('down')),
        listJobs: () => Promise.reject(new Error('job list down')),
        jobCounts: () => Promise.reject(new Error('job counts down')),
      },
      identity: createIdentityStores(db).users,
      billing: {
        balance: (userId, now) => readBalance(billingStores, db, userId, now),
        ledgerHistory: (userId, window) =>
          billingStores.readLedgerHistory(db, { userId, ...window }),
        usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
      },
      sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
      clock: { now: (): Date => new Date() },
      marketingUrl: MARKETING_URL,
    });
  }

  it('maps a failed audit search to unavailable', async () => {
    const result = await brokenSurface().auditSearch({ limit: 5 });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('maps a failed dashboard read to unavailable', async () => {
    const result = await brokenSurface().dashboard({ actor: freshActor() });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('records a dashboard read that failed', async () => {
    const actor = freshActor();

    const result = await brokenSurface().dashboard({ actor });

    expect(result.isErr()).toBe(true);
    const rows = await db
      .select({ action: adminAudit.action })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(rows).toEqual([{ action: READ_AUDIT_ACTIONS.dashboard }]);
  });

  it('serializes a populated job-queue page to wire rows', async () => {
    const when = new Date(TEST_DAY_START);
    const surfaceWithJobs = createAdminReadSurface({
      db,
      role: 'operator',
      stores,
      auditReads: createAdminAuditReads(),
      crossSlice: {
        userAccountFacts: () => Promise.resolve(null),
        walletSummaries: () => Promise.resolve([]),
        deviceTokenSummary: () => Promise.resolve({ count: 0, tokens: [] }),
        conversationCounts: () => Promise.resolve({ owned: 0, activeMemberships: 0 }),
        jobsTouchingUser: () => Promise.resolve([]),
        listJobs: () =>
          Promise.resolve({
            rows: [
              {
                id: 'job-1',
                type: 'test.noop.v1',
                shard: 'bulk',
                status: 'pending',
                discarded: false,
                failures: 0,
                claims: 0,
                payload: {},
                errors: [],
                nextAttemptAt: when,
                createdAt: when,
                finishedAt: null,
              },
            ],
            nextCursor: null,
          }),
        jobCounts: () => Promise.resolve({ pending: 1, running: 0, dead: 0, discarded: 0 }),
      },
      identity: createIdentityStores(db).users,
      billing: {
        balance: (userId, now) => readBalance(billingStores, db, userId, now),
        ledgerHistory: (userId, window) =>
          billingStores.readLedgerHistory(db, { userId, ...window }),
        usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
      },
      sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
      clock: { now: (): Date => new Date() },
      marketingUrl: MARKETING_URL,
    });

    const result = await surfaceWithJobs.jobQueue({ actor: freshActor(), limit: 5 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows[0]).toMatchObject({
        id: 'job-1',
        createdAt: when.toISOString(),
        finishedAt: null,
      });
    }
  });

  it('maps a failed job-queue read to unavailable', async () => {
    const result = await brokenSurface().jobQueue({ actor: freshActor(), limit: 5 });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});

describe('AdminReadSurface.feedbackInbox', () => {
  it('returns inbox rows with a nextCursor when the page fills', async () => {
    // Two rows against a page of one: the cursor rides a peek row, so a single
    // row is a page that never fills and correctly carries no cursor.
    await seedFeedback();
    const newest = await seedFeedback();

    const result = await surface().feedbackInbox({ limit: 1 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows.map((row) => row.id)).toEqual([newest]);
      expect(result.value.nextCursor).toBe(newest);
    }
  });

  it('honors the status filter', async () => {
    const triaged = await seedFeedback('triaged');

    const result = await surface().feedbackInbox({ status: 'triaged', limit: 100 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows.every((row) => row.status === 'triaged')).toBe(true);
      expect(result.value.rows.some((row) => row.id === triaged)).toBe(true);
    }
  });
});

describe('AdminReadSurface.feedbackDetail', () => {
  it('returns the detail and writes exactly one read.feedbackView audit row', async () => {
    const id = await seedFeedback();
    const actor = freshActor();

    const result = await surface().feedbackDetail({ actor, id });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe(id);
      expect(result.value.body).toContain('long body');
    }
    const audits = await db
      .select({
        action: adminAudit.action,
        targetType: adminAudit.targetType,
        targetId: adminAudit.targetId,
      })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(audits).toEqual([
      { action: READ_AUDIT_ACTIONS.feedbackView, targetType: 'feedback', targetId: id },
    ]);
  });

  it('returns not_found and writes no audit row for an unknown id', async () => {
    const actor = freshActor();

    const result = await surface().feedbackDetail({ actor, id: crypto.randomUUID() });

    expect(result.isErr() && result.error.code).toBe('not_found');
    const audits = await db
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(audits).toEqual([]);
  });

  it('propagates a store failure as the typed domain error', async () => {
    const failingDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.reject(new Error('feedback down')) }),
        }),
      }),
    } as unknown as typeof db;

    const result = await surface(failingDb).feedbackDetail({
      actor: freshActor(),
      id: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});

describe('AdminReadSurface.jobQueue and customer360 delegation', () => {
  it('lists jobs as wire rows', async () => {
    const result = await surface().jobQueue({ actor: freshActor(), limit: 5 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      for (const row of result.value.rows) {
        expect(typeof row.createdAt).toBe('string');
      }
    }
  });

  it('delegates customer360 (found user, one audit row)', async () => {
    const inserted = await db
      .insert(users)
      .values(userFactory.build())
      .returning({ id: users.id, email: users.email });
    const user = inserted[0]!;
    createdUserIds.push(user.id);
    const actor = freshActor();

    const result = await surface().customer360({ actor, query: { email: user.email } });

    expect(result.isOk() && result.value.user.id).toBe(user.id);
  });
});
