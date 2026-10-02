import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, jobs } from '@hushbox/db';
import {
  DAY_MS,
  HOUR_MS,
  TEST_DAY_START,
  TEST_YEAR_START,
  freezeClock,
  isoAt,
  setClock,
} from '@hushbox/shared/test-time';
import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync } from '../../../lib/result/index.js';
import {
  createAppJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
  jobWakesOf,
} from '../../../lib/jobs/index.js';
import { createMockEmailSender } from '../../notifications/index.js';
import { createAdminAuditDigestReads } from '../adapters/audit-reads.js';
import {
  ADMIN_DIGEST_JOB_TYPE,
  ADMIN_DIGEST_MAX_FAILURES,
  DIGEST_MAX_ACTIONS,
  createAdminDigestEnqueueEntry,
  createAdminDigestJobRegistration,
  digestWindowForDay,
  previousUtcDay,
} from './digest.js';
import type { AdminDigestSendDeps } from './digest.js';
import type { CronEntry, JobExecution, JobShard } from '../../../lib/jobs/index.js';
import type { MockEmailSender } from '../../notifications/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin digest entry integration tests');
}

/** Stands in for the boundary's collector: what the entry must merge into. */
const boundaryWakes = createJobWakeCollector();
const db = grantJobWakes(createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }), boundaryWakes);
const auditReads = createAdminAuditDigestReads(db);

const enqueuedDedupeKeys: string[] = [];

const ADMIN_URL = 'https://admin.hushbox.ai';

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  // admin_audit is append-only by trigger; rows stay, isolated by unique actor.
  // The jobs rows this file enqueues are not, and the dedupe index is partial
  // over pending/running — a leftover row would silently answer the next run's
  // dedupe assertion.
  for (const dedupeKey of enqueuedDedupeKeys) {
    await db.delete(jobs).where(eq(jobs.dedupeKey, dedupeKey));
  }
  await db.$client.end();
});

function executionFor(day: string): JobExecution<{ day: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload: { day },
    claims: 1,
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

function handlerWith(send: AdminDigestSendDeps): (day: string) => Promise<unknown> {
  const registration = createAdminDigestJobRegistration({ auditReads, resolveSend: () => send });
  return (day: string) => registration.handler(executionFor(day));
}

function mockSend(adminEmails: readonly string[]): {
  send: AdminDigestSendDeps;
  sender: MockEmailSender;
} {
  const sender = createMockEmailSender();
  return { send: { sender, adminEmails, adminUrl: ADMIN_URL }, sender };
}

/** A historic UTC day no other suite writes into; `admin_audit` is append-only. */
function isolatedDay(offsetDays: number): { day: string; startMs: number } {
  const startMs = Date.UTC(1990, 0, 1) + offsetDays * 24 * 60 * 60 * 1000;
  return { day: previousUtcDay(new Date(startMs + 24 * 60 * 60 * 1000)), startMs };
}

describe('the digest window', () => {
  it('names the previous full UTC day', () => {
    expect(previousUtcDay(new Date(TEST_DAY_START + 3 * HOUR_MS))).toBe('2026-01-14');
  });

  it('spans that day from midnight to midnight UTC', () => {
    const { since, until } = digestWindowForDay(isoAt(TEST_DAY_START).slice(0, 10));
    expect(since.toISOString()).toBe(isoAt(TEST_DAY_START));
    expect(until.toISOString()).toBe(isoAt(TEST_DAY_START + DAY_MS));
  });
});

describe('admin.digest.v1 registration', () => {
  it('declares the per-day-keyed delivery contract', () => {
    const { send } = mockSend(['admin@hushbox.ai']);
    const registration = createAdminDigestJobRegistration({ auditReads, resolveSend: () => send });
    expect(registration.type).toBe(ADMIN_DIGEST_JOB_TYPE);
    // The batch send carries the day-derived provider Idempotency-Key, which is
    // what makes redelivery deliver at most once per recipient.
    expect(registration.idempotency).toBe('providerKey');
    expect(registration.shard).toBe('bulk');
    expect(registration.maxFailures).toBe(ADMIN_DIGEST_MAX_FAILURES);
    expect(registration.maxExecutionSeconds).toBe(60);
    expect(registration.schema.safeParse({ day: '2026-07-13' }).success).toBe(true);
  });

  it('rejects a day that is not a real calendar date, at enqueue rather than in the handler', () => {
    const { send } = mockSend(['admin@hushbox.ai']);
    const { schema } = createAdminDigestJobRegistration({ auditReads, resolveSend: () => send });
    expect(schema.safeParse({ day: '2026-02-30' }).success).toBe(false);
    expect(schema.safeParse({ day: '13-07-2026' }).success).toBe(false);
    expect(schema.safeParse({ day: '2026-13-45' }).success).toBe(false);
  });
});

describe('the admin.digest.v1 handler', () => {
  it('composes the payload day of audit actions into one batch per admin recipient', async () => {
    const actor = `digest-test-${crypto.randomUUID()}@hushbox.ai`;
    const targetId = crypto.randomUUID();
    const { day, startMs } = isolatedDay(5000 + Math.floor(Math.random() * 5000));
    await db.insert(adminAudit).values([
      {
        actor,
        role: 'operator' as const,
        action: 'user.lock',
        targetType: 'user',
        targetId,
        details: { effects: [], inverseInput: null },
        createdAt: new Date(startMs),
      },
      {
        actor,
        role: 'operator' as const,
        action: 'wallet.credit',
        targetType: 'wallet',
        targetId,
        details: { effects: [], inverseInput: null },
        createdAt: new Date(startMs + 1000),
      },
    ]);
    const { send, sender } = mockSend(['admin@hushbox.ai', 'ops@hushbox.ai']);

    const outcome = await handlerWith(send)(day);

    expect(outcome).toEqual({ kind: 'ok', result: { recipients: 2, day } });
    const batches = sender.getSentBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.messages.map((message) => message.to)).toEqual([
      'admin@hushbox.ai',
      'ops@hushbox.ai',
    ]);
    const text = batches[0]?.messages[0]?.text ?? '';
    expect(batches[0]?.messages[0]?.subject).toContain(day);
    expect(text).toContain('user.lock');
    expect(text).toContain('wallet.credit');
    expect(text).toContain(actor);
  });

  it('sends every attempt for one day under the same idempotency key, so a retry cannot double-send', async () => {
    const { day } = isolatedDay(20_000 + Math.floor(Math.random() * 5000));
    const { send, sender } = mockSend(['admin@hushbox.ai']);
    const run = handlerWith(send);

    await run(day);
    await run(day);

    const keys = sender.getSentBatches().map((batch) => batch.idempotencyKey);
    expect(keys).toEqual([`${ADMIN_DIGEST_JOB_TYPE}:${day}`, `${ADMIN_DIGEST_JOB_TYPE}:${day}`]);
  });

  it('excludes rows outside the payload day', async () => {
    const actor = `digest-window-test-${crypto.randomUUID()}@hushbox.ai`;
    const { day, startMs } = isolatedDay(30_000 + Math.floor(Math.random() * 5000));
    await db.insert(adminAudit).values({
      actor,
      role: 'operator' as const,
      action: 'model.disable',
      details: { effects: [], inverseInput: null },
      // One day later: after the summarized window closes.
      createdAt: new Date(startMs + 24 * 60 * 60 * 1000),
    });
    const { send, sender } = mockSend(['admin@hushbox.ai']);

    await handlerWith(send)(day);

    expect(sender.getSentMessages()[0]?.text).not.toContain(actor);
  });

  it('leaves the target clause out for an in-window action carrying no target', async () => {
    const actor = `digest-null-target-test-${crypto.randomUUID()}@hushbox.ai`;
    const { day, startMs } = isolatedDay(0);
    await db.insert(adminAudit).values({
      actor,
      role: 'operator' as const,
      action: 'model.disable',
      details: { effects: [], inverseInput: null },
      createdAt: new Date(startMs),
    });
    const { send, sender } = mockSend(['admin@hushbox.ai']);

    await handlerWith(send)(day);

    expect(sender.getSentMessages()[0]?.text).toContain(
      `model.disable\nby ${actor} at ${isoAt(startMs)}`
    );
  });

  it('keeps the newest actions and drops the oldest on an over-cap day', async () => {
    const runId = crypto.randomUUID().slice(0, 8);
    const actor = `digest-cap-test-${runId}@hushbox.ai`;
    const { day, startMs } = isolatedDay(40_000 + Math.floor(Math.random() * 5000));
    const overCap = DIGEST_MAX_ACTIONS + 5;
    await db.insert(adminAudit).values(
      Array.from({ length: overCap }, (_, index) => ({
        actor,
        role: 'operator' as const,
        action: 'user.lock',
        targetType: 'user',
        targetId: `digest-cap-${runId}-${String(index)}`,
        details: { effects: [], inverseInput: null },
        createdAt: new Date(startMs + index * 1000),
      }))
    );
    const { send, sender } = mockSend(['admin@hushbox.ai']);

    await handlerWith(send)(day);

    const text = sender.getSentMessages()[0]?.text ?? '';
    // Newest under the cap survives; the oldest overflow rows are dropped.
    expect(text).toContain(`digest-cap-${runId}-${String(overCap - 1)}`);
    // No other index starts with 0, so the bare `-0` suffix is unambiguous.
    expect(text).not.toContain(`digest-cap-${runId}-0`);
  });

  it('fails the row on a send failure, so the dispatcher retries it', async () => {
    const { day } = isolatedDay(50_000);
    const outcome = await handlerWith({
      sender: {
        send: () => errAsync(unavailableError('send failed')),
        sendBatch: () => errAsync(unavailableError('send failed')),
      },
      adminEmails: ['admin@hushbox.ai'],
      adminUrl: ADMIN_URL,
    })(day);

    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
  });

  it('dates the email by the end of the summarized window, not by the clock', async () => {
    const day = isoAt(TEST_YEAR_START - DAY_MS).slice(0, 10);
    const { send, sender } = mockSend(['admin@hushbox.ai']);
    freezeClock(TEST_YEAR_START - HOUR_MS, { toFake: ['Date'] });

    await handlerWith(send)(day);

    expect(sender.getSentMessages()[0]?.text).toContain(
      `© ${String(new Date(TEST_YEAR_START).getUTCFullYear())} `
    );
  });

  it('renders the same batch body on either side of midnight, so a replay matches its key', async () => {
    const day = isoAt(TEST_YEAR_START - DAY_MS).slice(0, 10);
    const { send, sender } = mockSend(['admin@hushbox.ai']);
    const run = handlerWith(send);
    freezeClock(TEST_YEAR_START - HOUR_MS, { toFake: ['Date'] });
    await run(day);
    setClock(TEST_YEAR_START + HOUR_MS);
    await run(day);

    const [first, second] = sender.getSentBatches().map((batch) => batch.messages[0]);
    expect(second?.html).toBe(first?.html);
    expect(second?.text).toBe(first?.text);
  });

  it('succeeds without a provider call when no admin is allowlisted', async () => {
    const { day } = isolatedDay(60_000);
    const { send, sender } = mockSend([]);

    const outcome = await handlerWith(send)(day);

    expect(outcome).toEqual({ kind: 'ok', result: { recipients: 0, day } });
    expect(sender.getSentBatches()).toEqual([]);
  });
});

describe('createAdminDigestEnqueueEntry', () => {
  const registry = createAppJobRegistry([
    createAdminDigestJobRegistration({
      auditReads,
      resolveSend: () => mockSend(['admin@hushbox.ai']).send,
    }),
  ]);

  // Two enqueue cases share one live dedupe index, so their days come from
  // windows that cannot overlap — a random day drawn from one base must never
  // land on the other's.
  const DAY_WINDOW = 5000;

  function randomDayIn(baseYear: number): Date {
    return new Date(Date.UTC(baseYear, 0, 2) + Math.floor(Math.random() * DAY_WINDOW) * 86_400_000);
  }

  function entryFor(now: Date): CronEntry {
    return createAdminDigestEnqueueEntry({ db, resolveRegistry: () => registry, now: () => now });
  }

  /**
   * The shards the entry's own transaction collected, read off the very handle
   * its body was given — which is what distinguishes an invocation that
   * enqueued from one the dedupe key suppressed, where a monotone read of the
   * boundary collector could not.
   */
  async function wakesLeftBy(entry: CronEntry): Promise<readonly JobShard[]> {
    const openTransaction = db.transaction.bind(db);
    let collected: readonly JobShard[] = [];
    const spy = vi.spyOn(db, 'transaction').mockImplementation((body) =>
      openTransaction(async (tx) => {
        const result = await body(tx);
        collected = jobWakesOf(tx)?.shards() ?? [];
        return result;
      })
    );
    try {
      await entry.run();
    } finally {
      spy.mockRestore();
    }
    return collected;
  }

  /**
   * Runs the entry with its transaction handle intercepted, collecting a shard
   * through the very handle the entry's body was given: the capability rides
   * the handle, so this is what shows whether the opener minted a collector —
   * and, by aborting after the collect, whether it merges only on commit.
   */
  async function runCollectingThroughTransaction(
    entry: CronEntry,
    shard: JobShard,
    outcome: 'commit' | 'abort'
  ): Promise<void> {
    const openTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation((body) =>
      openTransaction(async (tx) => {
        const result = await body(tx);
        jobWakesOf(tx)?.collect(shard);
        if (outcome === 'abort') throw new Error('digest enqueue aborted');
        return result;
      })
    );
    try {
      await entry.run();
    } finally {
      spy.mockRestore();
    }
  }

  it('merges the enqueue transaction wakes into the caller collector once it commits', async () => {
    const now = randomDayIn(1971);
    enqueuedDedupeKeys.push(`${ADMIN_DIGEST_JOB_TYPE}:${previousUtcDay(now)}`);

    await runCollectingThroughTransaction(entryFor(now), 'bulk', 'commit');

    expect(boundaryWakes.shards()).toContain('bulk');
  });

  it('merges nothing into the caller collector when the enqueue transaction rolls back', async () => {
    const now = randomDayIn(1981);
    enqueuedDedupeKeys.push(`${ADMIN_DIGEST_JOB_TYPE}:${previousUtcDay(now)}`);

    await expect(
      runCollectingThroughTransaction(entryFor(now), 'default', 'abort')
    ).rejects.toThrow('digest enqueue aborted');

    expect(boundaryWakes.shards()).not.toContain('default');
  });

  it('enqueues one row for the previous UTC day and leaves its shard for the nudge', async () => {
    const now = randomDayIn(1991);
    const day = previousUtcDay(now);
    enqueuedDedupeKeys.push(`${ADMIN_DIGEST_JOB_TYPE}:${day}`);

    const woken = await wakesLeftBy(entryFor(now));

    const rows = await db
      .select({ type: jobs.type, payload: jobs.payload, shard: jobs.shard })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `${ADMIN_DIGEST_JOB_TYPE}:${day}`));
    expect(rows).toEqual([{ type: ADMIN_DIGEST_JOB_TYPE, payload: { day }, shard: 'bulk' }]);
    expect(woken).toEqual(['bulk']);
  });

  it('enqueues nothing on a second cron invocation for the same day', async () => {
    const now = randomDayIn(2011);
    const day = previousUtcDay(now);
    enqueuedDedupeKeys.push(`${ADMIN_DIGEST_JOB_TYPE}:${day}`);

    const first = await wakesLeftBy(entryFor(now));
    const second = await wakesLeftBy(entryFor(now));

    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `${ADMIN_DIGEST_JOB_TYPE}:${day}`));
    expect(rows).toHaveLength(1);
    expect(first).toEqual(['bulk']);
    // The duplicate invocation enqueued nothing, so it leaves no wake.
    expect(second).toEqual([]);
  });
});
