import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  newsletterDeliveries,
  newsletterIssues,
  newsletterSubscribers,
} from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { ResultAsync, err } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createMockEmailSender } from '../../notifications/index.js';
import {
  createNewsletterDispatchJobRegistration,
  newsletterDispatchPayloadSchema,
} from '../domain/dispatch.js';
import { createNewsletterDispatchStores } from './dispatch-stores.js';
import { createIssueWithinTx } from './issue-stores.js';
import type { NewsletterDeliveryStatus } from '@hushbox/shared';
import type { ExecutionBudget, JobOutcome } from '../../../lib/jobs/index.js';
import type { BatchEmailSender } from '../../notifications/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter dispatch store tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const store = createNewsletterDispatchStores(db);

const createdIssueIds: string[] = [];
const createdEmails: string[] = [];

/**
 * A fresh topic per test: the dispatch path refuses a list whose subscribed
 * rows span two topics, so recipients go with the test that made them.
 */
function nextTopic(): string {
  return `dispatch-store-test-${crypto.randomUUID().slice(0, 8)}`;
}

async function seedIssue(): Promise<string> {
  const issue = await db.transaction((tx) =>
    createIssueWithinTx(tx, {
      subject: 'Dispatch store issue',
      bodyMarkdown: 'Body **bold**',
      scheduledAt: new Date(TEST_DAY_START),
      createdBy: 'admin@hushbox.ai',
    })
  );
  createdIssueIds.push(issue.id);
  return issue.id;
}

async function seedSubscribers(topic: string, count: number): Promise<{ id: string }[]> {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const email = `store-${String(index)}-${crypto.randomUUID().slice(0, 8)}@newsletter-dispatch.test`;
    createdEmails.push(email);
    rows.push({
      email,
      status: 'subscribed' as const,
      topic,
      consentSource: 'marketing_site' as const,
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
    });
  }
  return db.insert(newsletterSubscribers).values(rows).returning({ id: newsletterSubscribers.id });
}

/** One delivery row parked at `status`, with its issue and recipient. */
async function seedDelivery(status: NewsletterDeliveryStatus): Promise<string> {
  const issueId = await seedIssue();
  const [subscriber] = await seedSubscribers(nextTopic(), 1);
  if (subscriber === undefined) throw new Error('subscriber seed returned no row');
  const inserted = await db
    .insert(newsletterDeliveries)
    .values({ issueId, subscriberId: subscriber.id, status })
    .returning({ id: newsletterDeliveries.id });
  const row = inserted[0];
  if (row === undefined) throw new Error('delivery seed returned no row');
  return row.id;
}

/** One issue's two delivery rows, parked one at `sent` and one at `claimed`. */
async function seedMixedDeliveries(): Promise<{ sentId: string; claimedId: string }> {
  const issueId = await seedIssue();
  const [first, second] = await seedSubscribers(nextTopic(), 2);
  if (first === undefined || second === undefined) {
    throw new Error('subscriber pair seed returned no rows');
  }
  const rows: { issueId: string; subscriberId: string; status: NewsletterDeliveryStatus }[] = [
    { issueId, subscriberId: first.id, status: 'sent' },
    { issueId, subscriberId: second.id, status: 'claimed' },
  ];
  const inserted = await db
    .insert(newsletterDeliveries)
    .values(rows)
    .returning({ id: newsletterDeliveries.id, status: newsletterDeliveries.status });
  const sent = inserted.find((row) => row.status === 'sent');
  const claimed = inserted.find((row) => row.status === 'claimed');
  if (sent === undefined || claimed === undefined) {
    throw new Error('delivery pair seed returned no rows');
  }
  return { sentId: sent.id, claimedId: claimed.id };
}

async function issueDeliveryStatuses(issueId: string): Promise<string[]> {
  const rows = await db
    .select({ status: newsletterDeliveries.status })
    .from(newsletterDeliveries)
    .where(eq(newsletterDeliveries.issueId, issueId));
  return rows.map((row) => row.status);
}

/** The registered budget, unspent: one execution runs the whole list. */
const UNSPENT_BUDGET: ExecutionBudget = { totalMs: 300_000, now: () => TEST_DAY_START };

const URLS = { apiUrl: 'https://api.hushbox.ai', marketingUrl: 'https://hushbox.ai' };

function runDispatch(
  topic: string,
  sender: BatchEmailSender,
  issueId: string
): Promise<JobOutcome> {
  const registration = createNewsletterDispatchJobRegistration({
    store,
    resolveSend: () => ({ sender, urls: URLS }),
    topic,
  });
  return registration.chunked.runChunks(
    newsletterDispatchPayloadSchema.parse({ issueId }),
    UNSPENT_BUDGET
  );
}

async function deliveryStatus(deliveryId: string): Promise<string> {
  const rows = await db
    .select({ status: newsletterDeliveries.status })
    .from(newsletterDeliveries)
    .where(eq(newsletterDeliveries.id, deliveryId));
  const row = rows[0];
  if (row === undefined) throw new Error('delivery row missing');
  return row.status;
}

afterEach(async () => {
  if (createdIssueIds.length > 0) {
    await db
      .delete(newsletterDeliveries)
      .where(inArray(newsletterDeliveries.issueId, createdIssueIds));
  }
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
    createdEmails.length = 0;
  }
});

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, createdIssueIds));
  }
  await db.$client.end();
});

describe('claimIssue', () => {
  it("returns the issue's scheduled date with a winning claim", async () => {
    const issueId = await seedIssue();

    const claim = await store.claimIssue(issueId, nextTopic());

    expect(claim).toEqual({
      kind: 'claimed',
      subject: 'Dispatch store issue',
      bodyMarkdown: 'Body **bold**',
      scheduledAt: new Date(TEST_DAY_START),
    });
  });

  it("returns the issue's scheduled date to the retry of a claim already sending", async () => {
    const issueId = await seedIssue();
    await db
      .update(newsletterIssues)
      .set({ status: 'sending' })
      .where(eq(newsletterIssues.id, issueId));

    const claim = await store.claimIssue(issueId, nextTopic());

    expect(claim).toEqual({
      kind: 'claimed',
      subject: 'Dispatch store issue',
      bodyMarkdown: 'Body **bold**',
      scheduledAt: new Date(TEST_DAY_START),
    });
  });
});

describe('markDeliveries', () => {
  it('leaves a sent row sent when a stale execution marks it failed', async () => {
    const deliveryId = await seedDelivery('sent');

    await store.markDeliveries([deliveryId], 'failed');

    expect(await deliveryStatus(deliveryId)).toBe('sent');
  });

  it('marks a failed row sent when a later attempt delivers it', async () => {
    // Characterization: the `sent` write is unguarded before this task and
    // stays unguarded after it, so this test is green on both sides. It is
    // what refuses a `claimed`-only guard, which would freeze the row here.
    const deliveryId = await seedDelivery('failed');

    await store.markDeliveries([deliveryId], 'sent', new Map([[deliveryId, 'resend-id']]));

    expect(await deliveryStatus(deliveryId)).toBe('sent');
  });

  it('fails only the claimed row when a stale execution marks a mixed page failed', async () => {
    // Characterization: the guard is one predicate on one statement, which a
    // single UPDATE applies row by row, so this is green before and after.
    const { sentId, claimedId } = await seedMixedDeliveries();

    await store.markDeliveries([sentId, claimedId], 'failed');

    expect(await deliveryStatus(sentId)).toBe('sent');
    expect(await deliveryStatus(claimedId)).toBe('failed');
  });

  it('leaves a page sent when a stale execution takes the send-error branch', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const liveSender = createMockEmailSender();
    let liveRan = false;
    // The stale execution loads its page, then this send hands control to a
    // live execution that delivers that same page, and only then errors —
    // which is the interleaving that puts a `sent` row under a `failed` write.
    const staleSender: BatchEmailSender = {
      send: (message) => liveSender.send(message),
      sendBatch: () =>
        ResultAsync.fromSafePromise(
          (async (): Promise<void> => {
            if (liveRan) return;
            liveRan = true;
            await runDispatch(topic, liveSender, issueId);
          })()
        ).andThen(() => err(unavailableError('provider down'))),
    };

    const outcome = await runDispatch(topic, staleSender, issueId);

    expect(outcome.kind).toBe('fail');
    expect(await issueDeliveryStatuses(issueId)).toEqual(['sent', 'sent']);
  });
});
