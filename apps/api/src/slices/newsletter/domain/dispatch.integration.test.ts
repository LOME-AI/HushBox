import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  jobs,
  newsletterDeliveries,
  newsletterIssues,
  newsletterSubscribers,
} from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import {
  HOUR_MS,
  MINUTE_MS,
  TEST_DAY_START,
  TEST_YEAR_START,
  freezeClock,
  setClock,
} from '@hushbox/shared/test-time';
import {
  createJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
} from '../../../lib/jobs/index.js';
import { errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createMockEmailSender } from '../../notifications/index.js';
import { createNewsletterDispatchStores } from '../adapters/dispatch-stores.js';
import { createNewsletterStores } from '../adapters/stores.js';
import { createIssueWithinTx } from '../adapters/issue-stores.js';
import {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  NEWSLETTER_DISPATCH_MAX_NOT_DUE_YIELDS,
  createNewsletterDispatchJobRegistration,
  enqueueIssueDispatch,
  newsletterDispatchPayloadSchema,
} from './dispatch.js';
import type { Database } from '@hushbox/db';
import type { z } from 'zod';
import type { ExecutionBudget, JobOutcome } from '../../../lib/jobs/index.js';
import type { BatchEmailSender, MockEmailSender } from '../../notifications/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter dispatch tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const URLS = { apiUrl: 'https://api.hushbox.ai', marketingUrl: 'https://hushbox.ai' };

interface RecordedStatement {
  text: string;
  rows: number;
}

/**
 * Statement recorder, on its own pool so the wrapper is installed before the
 * connection ever serves a query (`connect` fires once per physical
 * connection). `Pool#query` checks a client out too, so wrapping the client
 * catches single statements and transaction bodies alike, begin/commit
 * included — which is what makes a count over it a count of round trips.
 */
const countedDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
let recording: RecordedStatement[] | null = null;

interface RecordingClient {
  query: (...args: unknown[]) => unknown;
}

const countedPool = countedDb.$client as unknown as {
  on: (event: 'connect', listener: (client: RecordingClient) => void) => void;
};

countedPool.on('connect', (client) => {
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  const recorded = (...args: unknown[]): unknown => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string }).text ?? '');
    const entry: RecordedStatement = { text, rows: 0 };
    recording?.push(entry);
    const count = (result: unknown): void => {
      entry.rows = (result as { rowCount: number | null } | undefined)?.rowCount ?? 0;
    };
    // Both call shapes reach here: the pool's own `query` passes a callback,
    // while a transaction body awaits the promise form.
    const last = args.at(-1);
    if (typeof last === 'function') {
      const callback = last as (error: unknown, result: unknown) => void;
      const forwarded = [
        ...args.slice(0, -1),
        (error: unknown, result: unknown) => {
          count(result);
          callback(error, result);
        },
      ];
      return original(...forwarded);
    }
    const result = original(...args);
    if (!(result instanceof Promise)) return result;
    return (async (): Promise<unknown> => {
      const resolved: unknown = await result;
      count(resolved);
      return resolved;
    })();
  };
  client.query = recorded;
});

async function recordStatements(run: () => Promise<unknown>): Promise<RecordedStatement[]> {
  const statements: RecordedStatement[] = [];
  recording = statements;
  try {
    await run();
  } finally {
    recording = null;
  }
  return statements;
}

const verbOf = (statement: RecordedStatement): string =>
  statement.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

const isDeliveryInsert = (statement: RecordedStatement): boolean =>
  verbOf(statement) === 'insert' && /into "newsletter_deliveries"/i.test(statement.text);

const isSubscriberRead = (statement: RecordedStatement): boolean =>
  verbOf(statement) === 'select' && /from "newsletter_subscribers"/i.test(statement.text);

const isTopicGuardRead = (statement: RecordedStatement): boolean =>
  isSubscriberRead(statement) && /distinct "topic"/i.test(statement.text);

const isTargetRead = (statement: RecordedStatement): boolean =>
  verbOf(statement) === 'select' &&
  /from "newsletter_deliveries"/i.test(statement.text) &&
  /join "newsletter_subscribers"/i.test(statement.text);

const isDeliveryWrite = (statement: RecordedStatement): boolean =>
  verbOf(statement) === 'update' && /^update "newsletter_deliveries"/i.test(statement.text.trim());

// A fresh topic per test keeps every recipient load deterministic (the
// handler's topic is deps-bound) where one shared pool would couple the
// tests. The dispatch path refuses a list whose subscribed rows span two
// topics, so the rows go with the test that made them — see the afterEach.
function nextTopic(): string {
  return `dispatch-test-${crypto.randomUUID().slice(0, 8)}`;
}

const createdIssueIds: string[] = [];
const createdEmails: string[] = [];
const createdJobIds: string[] = [];

type Payload = z.infer<typeof newsletterDispatchPayloadSchema>;

/**
 * Payloads arrive at a handler parsed, so the helper parses too: a checkpoint
 * written before a payload field existed still reaches the handler with that
 * field's default, which is the case a raw object literal would hide.
 */
function payloadOf(payload: z.input<typeof newsletterDispatchPayloadSchema>): Payload {
  return newsletterDispatchPayloadSchema.parse(payload);
}

/** The registered budget, as the dispatcher would floor it for a fresh row. */
const EXECUTION_BUDGET_MS = 300_000;

/**
 * A budget the first page spends whole, so one execution sends one page — the
 * cadence a list long enough to fill a five-minute budget gets, made
 * deterministic.
 */
function onePageBudget(): ExecutionBudget {
  let readings = 0;
  return {
    totalMs: EXECUTION_BUDGET_MS,
    now: () => {
      readings += 1;
      // The loop reads the clock once on entry and once after each page.
      return readings === 1 ? TEST_DAY_START : TEST_DAY_START + EXECUTION_BUDGET_MS;
    },
  };
}

/** A budget nothing spends: one execution sends every page the list has. */
function unspentBudget(): ExecutionBudget {
  return { totalMs: EXECUTION_BUDGET_MS, now: () => TEST_DAY_START };
}

async function seedIssue(overrides: { scheduledAt?: Date; status?: string } = {}): Promise<string> {
  const issue = await db.transaction((tx) =>
    createIssueWithinTx(tx, {
      subject: 'Dispatch issue',
      bodyMarkdown: 'Body **bold**',
      scheduledAt: overrides.scheduledAt ?? new Date(Date.now() - 60_000),
      createdBy: 'admin@hushbox.ai',
    })
  );
  createdIssueIds.push(issue.id);
  if (overrides.status !== undefined && overrides.status !== 'scheduled') {
    await db
      .update(newsletterIssues)
      .set({ status: overrides.status as 'canceled' | 'sending' | 'sent' })
      .where(eq(newsletterIssues.id, issue.id));
  }
  return issue.id;
}

async function seedSubscribers(
  topic: string,
  count: number,
  status: 'subscribed' | 'unsubscribed' | 'suppressed' | 'pending' = 'subscribed'
): Promise<{ id: string; email: string }[]> {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const email = `dispatch-${status}-${String(index)}-${crypto.randomUUID().slice(0, 8)}@newsletter-dispatch.test`;
    createdEmails.push(email);
    rows.push({
      email,
      status,
      topic,
      consentSource: 'marketing_site' as const,
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
    });
  }
  const inserted = await db
    .insert(newsletterSubscribers)
    .values(rows)
    .returning({ id: newsletterSubscribers.id, email: newsletterSubscribers.email });
  return inserted;
}

interface Handler {
  /** One execution of the registered chunk loop, budgeted to a single page. */
  handler: (payload: Payload) => Promise<JobOutcome>;
  sender: MockEmailSender;
}

function makeHandler(
  topic: string,
  options: { batchSize?: number; sender?: BatchEmailSender; db?: Database } = {}
): Handler {
  const sender = createMockEmailSender();
  const registration = createNewsletterDispatchJobRegistration({
    store: createNewsletterDispatchStores(options.db ?? db),
    resolveSend: () => ({ sender: options.sender ?? sender, urls: URLS }),
    topic,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
  return {
    handler: (payload) => registration.chunked.runChunks(payload, onePageBudget()),
    sender,
  };
}

/** Drives the handler through yields exactly as the dispatcher would. */
async function runToTerminal(
  handlerOf: () => Handler['handler'],
  issueId: string
): Promise<JobOutcome> {
  let payload: Payload = newsletterDispatchPayloadSchema.parse({ issueId });
  for (;;) {
    const outcome = await handlerOf()(payloadOf(payload));
    if (outcome.kind !== 'yield') return outcome;
    payload = newsletterDispatchPayloadSchema.parse(outcome.checkpoint);
  }
}

async function deliveryRows(
  issueId: string
): Promise<{ subscriberId: string; status: string; resendEmailId: string | null }[]> {
  return db
    .select({
      subscriberId: newsletterDeliveries.subscriberId,
      status: newsletterDeliveries.status,
      resendEmailId: newsletterDeliveries.resendEmailId,
    })
    .from(newsletterDeliveries)
    .where(eq(newsletterDeliveries.issueId, issueId));
}

async function issueRow(issueId: string): Promise<typeof newsletterIssues.$inferSelect> {
  const rows = await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, issueId));
  const row = rows[0];
  if (row === undefined) throw new Error('issue row missing');
  return row;
}

/**
 * Subscribers are cleared between tests, not at the end: dispatch dead-letters
 * on a list whose subscribed rows span two topics, and every test mints its
 * own topic.
 */
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
    await db
      .delete(newsletterDeliveries)
      .where(inArray(newsletterDeliveries.issueId, createdIssueIds));
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, createdIssueIds));
  }
  if (createdJobIds.length > 0) {
    await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
  }
  await db.$client.end();
  await countedDb.$client.end();
});

describe('newsletter.dispatch.v1 registration', () => {
  it('registers on the bulk shard with natural idempotency and its payload schema', () => {
    const registry = createJobRegistry();
    const { sender } = makeHandler(nextTopic());
    registry.register(
      createNewsletterDispatchJobRegistration({
        store: createNewsletterDispatchStores(db),
        resolveSend: () => ({ sender, urls: URLS }),
      })
    );

    const registered = registry.get(NEWSLETTER_DISPATCH_JOB_TYPE);
    expect(registered?.shard).toBe('bulk');
    expect(registered?.idempotency).toBe('natural');
    expect(registered?.schema).toBe(newsletterDispatchPayloadSchema);
    expect(registered?.maxExecutionSeconds).toBe(300);
  });

  it('declares the chunked shape, its work scaling with the list it sends to', () => {
    const registration = createNewsletterDispatchJobRegistration({
      store: createNewsletterDispatchStores(db),
      resolveSend: () => ({ sender: createMockEmailSender(), urls: URLS }),
    });

    expect(registration.kind).toBe('chunked');
  });

  it('defaults an absent page position to the head of the frozen list', () => {
    const issueId = crypto.randomUUID();

    expect(newsletterDispatchPayloadSchema.parse({ issueId })).toEqual({
      issueId,
      cursor: null,
      notDueYields: 0,
    });
  });

  it('refuses a batch size over the provider cap', () => {
    const { sender } = makeHandler(nextTopic());
    expect(() =>
      createNewsletterDispatchJobRegistration({
        store: createNewsletterDispatchStores(db),
        resolveSend: () => ({ sender, urls: URLS }),
        batchSize: 101,
      })
    ).toThrow(/batch/i);
  });
});

describe('enqueueIssueDispatch', () => {
  function registryWith(): ReturnType<typeof createJobRegistry> {
    const registry = createJobRegistry();
    registry.register(
      createNewsletterDispatchJobRegistration({
        store: createNewsletterDispatchStores(db),
        resolveSend: () => ({ sender: createMockEmailSender(), urls: URLS }),
      })
    );
    return registry;
  }

  it('inserts the jobs row in the caller transaction', async () => {
    const registry = registryWith();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const { issueId, jobId } = await db.transaction(async (tx) => {
      const issue = await createIssueWithinTx(tx, {
        subject: 'Enqueued issue',
        bodyMarkdown: 'body',
        scheduledAt,
        createdBy: 'admin@hushbox.ai',
      });
      const enqueued = await enqueueIssueDispatch(
        grantJobWakes(tx, createJobWakeCollector()),
        registry,
        {
          issueId: issue.id,
          scheduledAt,
        }
      );
      if (!enqueued.enqueued) throw new Error('expected enqueue');
      return { issueId: issue.id, jobId: enqueued.jobId };
    });
    createdIssueIds.push(issueId);
    createdJobIds.push(jobId);

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(rows[0]?.type).toBe(NEWSLETTER_DISPATCH_JOB_TYPE);
    expect(rows[0]?.shard).toBe('bulk');
    expect(rows[0]?.payload).toEqual({ issueId, cursor: null, notDueYields: 0 });
    expect(rows[0]?.scheduledAt).toEqual(scheduledAt);
  });

  it('rolls the issue and the job back together', async () => {
    const registry = registryWith();
    let issueId = '';
    let jobId = '';
    await db
      .transaction(async (tx) => {
        const issue = await createIssueWithinTx(tx, {
          subject: 'Rolled back issue',
          bodyMarkdown: 'body',
          scheduledAt: new Date(),
          createdBy: 'admin@hushbox.ai',
        });
        issueId = issue.id;
        const enqueued = await enqueueIssueDispatch(
          grantJobWakes(tx, createJobWakeCollector()),
          registry,
          {
            issueId: issue.id,
            scheduledAt: new Date(),
          }
        );
        if (enqueued.enqueued) jobId = enqueued.jobId;
        throw new Error('force rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'force rollback') throw error;
      });

    expect(
      await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, issueId))
    ).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.id, jobId))).toEqual([]);
  });
});

describe('newsletter.dispatch.v1 handler', () => {
  it('sends every subscribed recipient across batches and completes the issue', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 5);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const outcome = await runToTerminal(() => handler, issueId);

    expect(outcome.kind).toBe('ok');
    const batches = sender.getSentBatches();
    expect(batches).toHaveLength(3);
    // One key per page of the frozen list, each naming that page's own start.
    const ordered = subscribers.toSorted((left, right) => left.id.localeCompare(right.id));
    expect(batches.map((batch) => batch.idempotencyKey)).toEqual([
      `newsletter:${issueId}:head`,
      `newsletter:${issueId}:${String(ordered[1]?.id)}`,
      `newsletter:${issueId}:${String(ordered[3]?.id)}`,
    ]);
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(new Set(sentTo)).toEqual(new Set(subscribers.map((subscriber) => subscriber.email)));

    const deliveries = await deliveryRows(issueId);
    expect(deliveries).toHaveLength(5);
    expect(deliveries.every((row) => row.status === 'sent' && row.resendEmailId !== null)).toBe(
      true
    );

    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.sentAt).not.toBeNull();
    expect(issue.recipientCount).toBe(5);
    expect(issue.sentCount).toBe(5);
    expect(issue.failedCount).toBe(0);
  });

  it('sends every page in one execution while the budget is not nearly spent', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 5);
    const issueId = await seedIssue();
    const sender = createMockEmailSender();
    const registration = createNewsletterDispatchJobRegistration({
      store: createNewsletterDispatchStores(db),
      resolveSend: () => ({ sender, urls: URLS }),
      topic,
      batchSize: 2,
    });

    const outcome = await registration.chunked.runChunks(payloadOf({ issueId }), unspentBudget());

    // More pages per execution is the intended effect of a budgeted loop; what
    // it may not change is which recipients are sent to, in what order, how
    // many times, or under which per-page key.
    expect(outcome.kind).toBe('ok');
    const ordered = subscribers.toSorted((left, right) => left.id.localeCompare(right.id));
    expect(sender.getSentBatches().map((batch) => batch.idempotencyKey)).toEqual([
      `newsletter:${issueId}:head`,
      `newsletter:${issueId}:${String(ordered[1]?.id)}`,
      `newsletter:${issueId}:${String(ordered[3]?.id)}`,
    ]);
    expect(sender.getSentMessages().map((message) => message.to)).toEqual(
      ordered.map((subscriber) => subscriber.email)
    );
    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.sentCount).toBe(5);
  });

  it('yields a schema-valid checkpoint between batches without consuming retries', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 3);
    const issueId = await seedIssue();
    const { handler } = makeHandler(topic, { batchSize: 2 });

    const outcome = await handler(payloadOf({ issueId }));

    expect(outcome.kind).toBe('yield');
    if (outcome.kind !== 'yield') throw new Error('expected yield');
    const ordered = subscribers.toSorted((left, right) => left.id.localeCompare(right.id));
    expect(newsletterDispatchPayloadSchema.parse(outcome.checkpoint)).toEqual({
      issueId,
      cursor: ordered[1]?.id,
      notDueYields: 0,
    });
  });

  it('excludes unsubscribed, suppressed, and pending rows at load time', async () => {
    const topic = nextTopic();
    const subscribed = await seedSubscribers(topic, 2);
    await seedSubscribers(topic, 1, 'unsubscribed');
    await seedSubscribers(topic, 1, 'suppressed');
    await seedSubscribers(topic, 1, 'pending');
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 100 });

    const outcome = await runToTerminal(() => handler, issueId);

    expect(outcome.kind).toBe('ok');
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(new Set(sentTo)).toEqual(new Set(subscribed.map((subscriber) => subscriber.email)));
    expect(await deliveryRows(issueId)).toHaveLength(2);
  });

  it('personalizes one-click unsubscribe headers per recipient, never crossing tokens', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 100 });

    const outcome = await runToTerminal(() => handler, issueId);
    expect(outcome.kind).toBe('ok');

    const tokenRows = await db
      .select({
        email: newsletterSubscribers.email,
        token: newsletterSubscribers.unsubscribeToken,
      })
      .from(newsletterSubscribers)
      .where(
        inArray(
          newsletterSubscribers.id,
          subscribers.map((subscriber) => subscriber.id)
        )
      );
    const tokenByEmail = new Map(tokenRows.map((row) => [row.email, row.token]));
    const messages = sender.getSentMessages();
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      const ownToken = tokenByEmail.get(message.to);
      expect(ownToken).toBeDefined();
      expect(message.headers?.['List-Unsubscribe']).toBe(
        `<https://api.hushbox.ai/newsletter/unsubscribe?token=${String(ownToken)}>`
      );
      expect(message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
  });

  it('no-ops a canceled issue without creating deliveries', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const issueId = await seedIssue({ status: 'canceled' });
    const { handler, sender } = makeHandler(topic);

    const outcome = await handler(payloadOf({ issueId }));

    expect(outcome.kind).toBe('ok');
    expect(sender.getSentBatches()).toEqual([]);
    expect(await deliveryRows(issueId)).toEqual([]);
  });

  it('checkpoints a scheduled issue that is not yet due, spending no failure', async () => {
    const issueId = await seedIssue({ scheduledAt: new Date(Date.now() + HOUR_MS) });
    const { handler } = makeHandler(nextTopic());

    const outcome = await handler(payloadOf({ issueId }));

    expect(outcome.kind).toBe('yield');
    if (outcome.kind !== 'yield') throw new Error('expected yield');
    expect(newsletterDispatchPayloadSchema.parse(outcome.checkpoint).notDueYields).toBe(1);
  });

  it('fails a not-yet-due issue once its checkpoint bound is spent', async () => {
    const issueId = await seedIssue({ scheduledAt: new Date(Date.now() + HOUR_MS) });
    const { handler } = makeHandler(nextTopic());

    const outcome = await handler(
      payloadOf({ issueId, notDueYields: NEWSLETTER_DISPATCH_MAX_NOT_DUE_YIELDS })
    );

    expect(outcome.kind).toBe('fail');
  });

  it('measures due-ness against the database clock, not the worker clock', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const issueId = await seedIssue();
    // Due by the database's own clock, and far in the future by the worker's.
    await db
      .update(newsletterIssues)
      .set({ scheduledAt: sql`now()` })
      .where(eq(newsletterIssues.id, issueId));
    const { handler, sender } = makeHandler(topic);
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });

    try {
      const outcome = await handler(payloadOf({ issueId }));

      expect(outcome.kind).toBe('ok');
      expect(sender.getSentBatches()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dead-letters an unknown issue id', async () => {
    const { handler } = makeHandler(nextTopic());

    const outcome = await handler(payloadOf({ issueId: crypto.randomUUID() }));

    expect(outcome.kind).toBe('dead');
  });

  it('never re-sends completed batches after a mid-run send failure', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 4);
    const issueId = await seedIssue();
    const recorder = createMockEmailSender();
    let calls = 0;
    let failOnCall = 2;
    const flaky: BatchEmailSender = {
      send: (message) => recorder.send(message),
      sendBatch: (messages, options) => {
        calls += 1;
        if (calls === failOnCall) {
          return errAsync(unavailableError('provider down'));
        }
        return recorder.sendBatch(messages, options);
      },
    };
    const { handler } = makeHandler(topic, { batchSize: 2, sender: flaky });

    // First attempt: batch 0 sends, yields; second attempt: batch 1 send fails.
    const first = await handler(payloadOf({ issueId }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');
    const checkpoint = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    const second = await handler(payloadOf(checkpoint));
    expect(second.kind).toBe('fail');
    const rowsAfterFailure = await deliveryRows(issueId);
    const failedRows = rowsAfterFailure.filter((row) => row.status === 'failed');
    expect(failedRows).toHaveLength(2);

    // Dispatcher retry: the same checkpoint payload re-runs; the failed batch
    // finishes; batch 0 recipients are never re-sent.
    failOnCall = -1;
    const third = await runToTerminal(() => handler, issueId);
    expect(third.kind).toBe('ok');

    const sentTo = recorder.getSentMessages().map((message) => message.to);
    expect(sentTo).toHaveLength(4);
    expect(new Set(sentTo)).toEqual(new Set(subscribers.map((subscriber) => subscriber.email)));
    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.sentCount).toBe(4);
  });

  it('sends nothing twice when the whole handler re-executes after completion', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 3);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const firstRun = await runToTerminal(() => handler, issueId);
    expect(firstRun.kind).toBe('ok');
    const sentAfterFirst = sender.getSentMessages().length;

    // Lease-reclaim simulation: the original payload replays from scratch.
    const replay = await handler(payloadOf({ issueId }));

    expect(replay.kind).toBe('ok');
    expect(sender.getSentMessages()).toHaveLength(sentAfterFirst);
    const issueAfterReplay = await issueRow(issueId);
    expect(issueAfterReplay.sentCount).toBe(3);
  });

  async function seedPendingWithToken(
    topic: string
  ): Promise<{ id: string; email: string; confirmToken: string }> {
    const [row] = await seedSubscribers(topic, 1, 'pending');
    if (row === undefined) throw new Error('seed failed');
    const confirmToken = crypto.randomUUID();
    await db
      .update(newsletterSubscribers)
      .set({ confirmToken, confirmExpiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(newsletterSubscribers.id, row.id));
    return { ...row, confirmToken };
  }

  it('freezes recipients at claim: a mid-dispatch confirmation joins no in-flight issue', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    // Seeded mid-sequence so its uuidv7 id sorts inside the frozen list.
    const pending = await seedPendingWithToken(topic);
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const first = await handler(payloadOf({ issueId }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');

    const confirmed = await createNewsletterStores(db).consumeConfirmToken(
      pending.confirmToken,
      new Date()
    );
    expect(confirmed._unsafeUnwrap()).toBe(true);

    let payload = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    let outcome = await handler(payloadOf(payload));
    while (outcome.kind === 'yield') {
      payload = newsletterDispatchPayloadSchema.parse(outcome.checkpoint);
      outcome = await handler(payloadOf(payload));
    }
    expect(outcome.kind).toBe('ok');

    const rows = await deliveryRows(issueId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.subscriberId)).not.toContain(pending.id);
    expect(rows.every((row) => row.status === 'sent')).toBe(true);
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(sentTo).toHaveLength(3);
    expect(sentTo).not.toContain(pending.email);
    const issue = await issueRow(issueId);
    expect(issue.recipientCount).toBe(3);
    expect(issue.sentCount).toBe(3);
    expect(issue.failedCount).toBe(0);
  });

  it('replays a failed batch with its original frozen composition after a mid-dispatch flip', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const pending = await seedPendingWithToken(topic);
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const recorder = createMockEmailSender();
    const attempts: { key: string; to: string[] }[] = [];
    let calls = 0;
    const flaky: BatchEmailSender = {
      send: (message) => recorder.send(message),
      sendBatch: (messages, options) => {
        attempts.push({
          key: options.idempotencyKey,
          to: messages.map((message) => message.to),
        });
        calls += 1;
        if (calls === 2) return errAsync(unavailableError('provider down'));
        return recorder.sendBatch(messages, options);
      },
    };
    const { handler } = makeHandler(topic, { batchSize: 2, sender: flaky });

    const first = await handler(payloadOf({ issueId }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');
    const checkpoint = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    const second = await handler(payloadOf(checkpoint));
    expect(second.kind).toBe('fail');

    const confirmed = await createNewsletterStores(db).consumeConfirmToken(
      pending.confirmToken,
      new Date()
    );
    expect(confirmed._unsafeUnwrap()).toBe(true);

    const third = await handler(payloadOf(checkpoint));
    expect(third.kind).toBe('ok');

    const batchOneAttempts = attempts.filter(
      (attempt) => attempt.key === `newsletter:${issueId}:${String(checkpoint.cursor)}`
    );
    expect(batchOneAttempts).toHaveLength(2);
    expect(batchOneAttempts[1]?.to).toEqual(batchOneAttempts[0]?.to);
    expect(attempts.flatMap((attempt) => attempt.to)).not.toContain(pending.email);
  });

  it('leaves a due issue scheduled when the send deps do not resolve', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const issueId = await seedIssue();
    const registration = createNewsletterDispatchJobRegistration({
      store: createNewsletterDispatchStores(db),
      resolveSend: () => {
        throw new Error('issue email urls are unconfigured');
      },
      topic,
    });

    await expect(
      registration.chunked.runChunks(payloadOf({ issueId }), onePageBudget())
    ).rejects.toThrow('unconfigured');

    const issue = await issueRow(issueId);
    expect(issue.status).toBe('scheduled');
  });

  it('dead-letters instead of sending when the subscriber list holds a second topic', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    await seedSubscribers(nextTopic(), 1);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic);

    const outcome = await handler(payloadOf({ issueId }));

    expect(outcome.kind).toBe('dead');
    expect(sender.getSentBatches()).toEqual([]);
    const unclaimed = await issueRow(issueId);
    expect(unclaimed.status).toBe('scheduled');
    expect(await deliveryRows(issueId)).toEqual([]);
  });

  it('sends the rest of a frozen issue when a second topic appears mid-dispatch', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 4);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const first = await handler(payloadOf({ issueId }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');

    await seedSubscribers(nextTopic(), 1);

    let payload = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    let outcome = await handler(payloadOf(payload));
    while (outcome.kind === 'yield') {
      payload = newsletterDispatchPayloadSchema.parse(outcome.checkpoint);
      outcome = await handler(payloadOf(payload));
    }

    expect(outcome.kind).toBe('ok');
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(new Set(sentTo)).toEqual(new Set(subscribers.map((subscriber) => subscriber.email)));
    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
  });

  it('replays a page under the same idempotency key whatever counter its payload carries', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const recorder = createMockEmailSender();
    const keys: string[] = [];
    let calls = 0;
    const flaky: BatchEmailSender = {
      send: (message) => recorder.send(message),
      sendBatch: (messages, options) => {
        keys.push(options.idempotencyKey);
        calls += 1;
        if (calls === 1) return errAsync(unavailableError('provider down'));
        return recorder.sendBatch(messages, options);
      },
    };
    const { handler } = makeHandler(topic, { sender: flaky });

    const first = await handler(payloadOf({ issueId }));
    expect(first.kind).toBe('fail');
    // A checkpoint written before the page position existed carries only the
    // superseded attempt counter, so it reads the same head page as a fresh
    // payload — and must therefore replay under the same key.
    const second = await handler(
      payloadOf(newsletterDispatchPayloadSchema.parse({ issueId, nextBatchIndex: 5 }))
    );

    expect(second.kind).toBe('ok');
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("stamps every recipient's copyright year from the issue's scheduled date", async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 2);
    const scheduledAt = new Date(TEST_YEAR_START - HOUR_MS);
    const issueId = await seedIssue({ scheduledAt });
    const { handler, sender } = makeHandler(topic);
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });

    try {
      const outcome = await handler(payloadOf({ issueId }));

      expect(outcome.kind).toBe('ok');
      const year = String(scheduledAt.getUTCFullYear());
      const texts = sender.getSentMessages().map((message) => message.text);
      expect(texts).toHaveLength(2);
      for (const text of texts) expect(text).toContain(`© ${year} `);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays a failed batch with byte-identical bodies after the clock crosses a year', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue({ scheduledAt: new Date(TEST_YEAR_START - HOUR_MS) });
    const recorder = createMockEmailSender();
    const attempts: { html: string; text: string | undefined }[][] = [];
    const flaky: BatchEmailSender = {
      send: (message) => recorder.send(message),
      sendBatch: (messages, options) => {
        attempts.push(messages.map((message) => ({ html: message.html, text: message.text })));
        if (attempts.length === 1) return errAsync(unavailableError('provider down'));
        return recorder.sendBatch(messages, options);
      },
    };
    const { handler } = makeHandler(topic, { sender: flaky });
    freezeClock(TEST_YEAR_START - MINUTE_MS, { toFake: ['Date'] });

    try {
      const first = await handler(payloadOf({ issueId }));
      expect(first.kind).toBe('fail');
      setClock(TEST_YEAR_START + MINUTE_MS);
      const second = await handler(payloadOf({ issueId }));
      expect(second.kind).toBe('ok');
    } finally {
      vi.useRealTimers();
    }

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it('completes an issue with zero subscribed recipients', async () => {
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(nextTopic());

    const outcome = await handler(payloadOf({ issueId }));

    expect(outcome.kind).toBe('ok');
    expect(sender.getSentBatches()).toEqual([]);
    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.recipientCount).toBe(0);
  });
});

describe('newsletter.dispatch.v1 database cost', () => {
  it('reads each recipient once over a multi-batch run and writes one update per batch', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 5);
    const issueId = await seedIssue();
    const { handler } = makeHandler(topic, { batchSize: 2, db: countedDb });

    const statements = await recordStatements(() => runToTerminal(() => handler, issueId));

    const reads = statements.filter((statement) => isTargetRead(statement));
    expect({
      readStatements: reads.length,
      rowsRead: reads.reduce((total, read) => total + read.rows, 0),
      writeStatements: statements.filter((statement) => isDeliveryWrite(statement)).length,
    }).toEqual({ readStatements: 3, rowsRead: 5, writeStatements: 3 });
  });

  it('asserts the single-audience invariant once per dispatch, not once per attempt', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 5);
    const issueId = await seedIssue();
    const { handler } = makeHandler(topic, { batchSize: 2, db: countedDb });

    const statements = await recordStatements(() => runToTerminal(() => handler, issueId));

    expect(statements.filter((statement) => isTopicGuardRead(statement))).toHaveLength(1);
  });

  it('freezes the list with one insert and no client-side read of the recipients', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 5);
    const issueId = await seedIssue();
    const store = createNewsletterDispatchStores(countedDb);

    const statements = await recordStatements(() => store.claimIssue(issueId, topic));

    expect(statements.map((statement) => verbOf(statement))).toEqual([
      'begin',
      'update',
      'insert',
      'commit',
    ]);
    expect(statements.filter((statement) => isDeliveryInsert(statement))).toHaveLength(1);
    expect(statements.filter((statement) => isSubscriberRead(statement))).toEqual([]);
    expect(await deliveryRows(issueId)).toHaveLength(5);
  });

  it('marks nothing with no statement at all when the batch has no rows to mark', async () => {
    const store = createNewsletterDispatchStores(countedDb);

    const statements = await recordStatements(() => store.markDeliveries([], 'failed'));

    expect(statements).toEqual([]);
  });

  it('leaves the issue scheduled and the list unfrozen when the freeze aborts', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 3);
    const issueId = await seedIssue();
    const [first] = subscribers;
    if (first === undefined) throw new Error('seed failed');
    // A row the freeze's own UNIQUE(issueId, subscriberId) collides with, so
    // the insert aborts after the status flip has already been written.
    await db
      .insert(newsletterDeliveries)
      .values({ issueId, subscriberId: first.id, status: 'sent' });
    const store = createNewsletterDispatchStores(db);

    await expect(store.claimIssue(issueId, topic)).rejects.toThrow();

    const issue = await issueRow(issueId);
    expect(issue.status).toBe('scheduled');
    expect(await deliveryRows(issueId)).toHaveLength(1);
  });
});
