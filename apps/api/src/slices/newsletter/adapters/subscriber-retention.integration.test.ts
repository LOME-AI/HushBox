import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  newsletterDeliveries,
  newsletterIssues,
  newsletterSubscribers,
} from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import {
  UNCONFIRMED_SUBSCRIBER_GRACE_MS,
  purgeUnconfirmedSubscribers,
} from './subscriber-retention.js';
import type { NewsletterStatus } from '@hushbox/shared';
import type { DbTransaction } from '../../../lib/idempotency/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter retention tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const GRACE_HOURS = UNCONFIRMED_SUBSCRIBER_GRACE_MS / (60 * 60 * 1000);

class Rollback extends Error {}

async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

/** A row whose confirm credential expired `expiredHoursAgo` hours before now. */
async function insertSubscriber(
  tx: DbTransaction,
  status: NewsletterStatus,
  expiredHoursAgo: number
): Promise<string> {
  const rows = await tx
    .insert(newsletterSubscribers)
    .values({
      email: `${crypto.randomUUID()}@newsletter-retention.test`,
      status,
      consentSource: 'marketing_site',
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
      confirmToken: crypto.randomUUID(),
      confirmExpiresAt: sql`now() - make_interval(hours => ${expiredHoursAgo})`,
    })
    .returning({ id: newsletterSubscribers.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert subscriber');
  return row.id;
}

/** A delivery row keyed to the subscriber, on a freshly inserted issue. */
async function insertDelivery(tx: DbTransaction, subscriberId: string): Promise<void> {
  const issues = await tx
    .insert(newsletterIssues)
    .values({
      subject: 'retention fixture',
      bodyMarkdown: 'body',
      status: 'sent',
      scheduledAt: sql`now()`,
      createdBy: 'fixture@hushbox.ai',
    })
    .returning({ id: newsletterIssues.id });
  const issue = issues[0];
  if (issue === undefined) throw new Error('failed to insert issue');
  await tx.insert(newsletterDeliveries).values({ issueId: issue.id, subscriberId, status: 'sent' });
}

async function exists(tx: DbTransaction, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: newsletterSubscribers.id })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.id, id));
  return rows.length === 1;
}

afterAll(async () => {
  await db.$client.end();
});

describe('purgeUnconfirmedSubscribers', () => {
  it('deletes a pending signup whose confirm credential expired beyond the grace', async () => {
    const kept = await withRollback(async (tx) => {
      const id = await insertSubscriber(tx, 'pending', GRACE_HOURS + 1);
      await purgeUnconfirmedSubscribers(tx, { batchSize: 1000 });
      return exists(tx, id);
    });
    expect(kept).toBe(false);
  });

  it('keeps a pending signup still inside the grace', async () => {
    const kept = await withRollback(async (tx) => {
      const id = await insertSubscriber(tx, 'pending', GRACE_HOURS - 1);
      await purgeUnconfirmedSubscribers(tx, { batchSize: 1000 });
      return exists(tx, id);
    });
    expect(kept).toBe(true);
  });

  it('keeps a confirmed subscriber of the same age', async () => {
    const kept = await withRollback(async (tx) => {
      const id = await insertSubscriber(tx, 'subscribed', GRACE_HOURS + 1);
      await purgeUnconfirmedSubscribers(tx, { batchSize: 1000 });
      return exists(tx, id);
    });
    expect(kept).toBe(true);
  });

  it('keeps an unsubscribed row of the same age', async () => {
    const kept = await withRollback(async (tx) => {
      const id = await insertSubscriber(tx, 'unsubscribed', GRACE_HOURS + 1);
      await purgeUnconfirmedSubscribers(tx, { batchSize: 1000 });
      return exists(tx, id);
    });
    expect(kept).toBe(true);
  });

  it('deletes at most the batch size per call', async () => {
    const counts = await withRollback(async (tx) => {
      await insertSubscriber(tx, 'pending', GRACE_HOURS + 2);
      await insertSubscriber(tx, 'pending', GRACE_HOURS + 3);
      await insertSubscriber(tx, 'pending', GRACE_HOURS + 4);
      const first = await purgeUnconfirmedSubscribers(tx, { batchSize: 2 });
      const second = await purgeUnconfirmedSubscribers(tx, { batchSize: 2 });
      return { first, second };
    });
    expect(counts.first).toBe(2);
    expect(counts.second).toBeGreaterThanOrEqual(1);
  });

  it('keeps an expired pending signup that owns delivery rows', async () => {
    const kept = await withRollback(async (tx) => {
      const withDelivery = await insertSubscriber(tx, 'pending', GRACE_HOURS + 1);
      await insertDelivery(tx, withDelivery);
      await insertSubscriber(tx, 'pending', GRACE_HOURS + 1);
      await purgeUnconfirmedSubscribers(tx, { batchSize: 1000 });
      return exists(tx, withDelivery);
    });
    expect(kept).toBe(true);
  });

  it('still deletes a childless expired signup in a pass holding a delivery-bearing one', async () => {
    const kept = await withRollback(async (tx) => {
      const withDelivery = await insertSubscriber(tx, 'pending', GRACE_HOURS + 1);
      await insertDelivery(tx, withDelivery);
      const childless = await insertSubscriber(tx, 'pending', GRACE_HOURS + 1);
      await purgeUnconfirmedSubscribers(tx, { batchSize: 1000 });
      return exists(tx, childless);
    });
    expect(kept).toBe(false);
  });
});
