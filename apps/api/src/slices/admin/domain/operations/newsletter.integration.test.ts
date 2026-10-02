import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  jobs,
  newsletterIssues,
} from '@hushbox/db';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import {
  createAppJobRegistry,
  createJobWakeCollector,
  grantJobWakes,
} from '../../../../lib/jobs/index.js';
import {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  createNewsletterDispatchJobRegistration,
  createNewsletterDispatchStores,
  enqueueIssueDispatch,
} from '../../../newsletter/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { withUndoReason } from '../undo-round-trip.js';
import { adminNewsletterOperations } from './index.js';
import type { JobShard } from '../../../../lib/jobs/index.js';
import type { BatchEmailSender } from '../../../notifications/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks, AdminOpRunResult } from '../engine.js';
import type {
  AdminOpHarnessInstance,
  AdminOpInterleavingAction,
  AdminOpInterleavingConfig,
} from '../describe-admin-op.js';
import type { AdminNewsletterDeps, AdminNewsletterPostDeps } from './newsletter.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('DATABASE_URL is required for admin newsletter op tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const adminStores = createAdminStores();

const SCHEDULE_CONTRACT = ADMIN_OP_CONTRACTS['newsletter.schedule'];
const CANCEL_CONTRACT = ADMIN_OP_CONTRACTS['newsletter.cancel'];
const TEST_SEND_CONTRACT = ADMIN_OP_CONTRACTS['newsletter.testSend'];

/** Every harness subject starts with this, so cleanup targets only this run. */
const RUN_MARKER = `admin-nl-op ${crypto.randomUUID()}`;

const FUTURE_ISO = isoAt(TEST_DAY_START + 365_000 * DAY_MS);
const PAST_ISO = isoAt(TEST_DAY_START - 25 * 365 * DAY_MS);

afterAll(async () => {
  const issueRows = await db
    .select({ id: newsletterIssues.id })
    .from(newsletterIssues)
    .where(like(newsletterIssues.subject, `${RUN_MARKER}%`));
  const issueIds = issueRows.map((row) => row.id);
  if (issueIds.length > 0) {
    const dedupeKeys = issueIds.map((id) => `newsletter.dispatch:${id}`);
    await db.delete(jobs).where(inArray(jobs.dedupeKey, dedupeKeys));
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, issueIds));
  }
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/newsletter.%'));
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    captureError: noop,
  };
}

/** Dispatch never runs in these tests; the registration only shapes enqueue. */
const inertBatchSender: BatchEmailSender = {
  send: () => okAsync(),
  sendBatch: () => okAsync({ ids: [] }),
};

const dispatchRegistry = createAppJobRegistry([
  createNewsletterDispatchJobRegistration({
    store: createNewsletterDispatchStores(db),
    resolveSend: () => ({
      sender: inertBatchSender,
      urls: { apiUrl: 'http://api.test.local', marketingUrl: 'http://marketing.test.local' },
    }),
  }),
]);

interface NewsletterHarness extends AdminOpHarnessInstance {
  readonly marker: string;
  /** The shards this harness's schedule left for the boundary to nudge. */
  readonly wakes: () => readonly JobShard[];
  readonly sentTestEmails: readonly { readonly to: string; readonly subject: string }[];
  readonly ephemeral: NonNullable<AdminOpHarnessInstance['ephemeral']>;
}

interface HarnessOptions {
  hooks?: AdminOpEngineHooks;
}

function createNewsletterHarness(options: HarnessOptions = {}): NewsletterHarness {
  const actor = `nl-admin-${crypto.randomUUID()}@hushbox.ai`;
  const marker = `${RUN_MARKER} ${crypto.randomUUID()}`;
  const sentTestEmails: { to: string; subject: string }[] = [];
  // The post-commit log for the ops' ephemerals. `testSend`'s email is the only
  // ephemeral this family registers, so every entry is an `email:` — the
  // battery's probes read it, armed failure throws BEFORE recording (the
  // job.redrive probe precedent).
  const ephemeralLog: string[] = [];
  let ephemeralArmedToFail = false;
  // A collector per harness on the shared handle: re-granting REPLACES the
  // collector, which is the per-test isolation wanted here (files run their
  // tests in order) and is exactly why a production boundary keeps its mint
  // and its discharge in one scope instead.
  const jobWakes = createJobWakeCollector();
  grantJobWakes(db, jobWakes);
  const deps: AdminNewsletterDeps = {
    clock: { now: (): Date => new Date() },
    actorEmail: (): string => actor,
    newsletterDispatch: {
      enqueueWithinTx: (tx, params) => enqueueIssueDispatch(tx, dispatchRegistry, params),
    },
    newsletterIssueReader: {
      readWithinTx: async (tx, issueId) => {
        const rows = await tx
          .select()
          .from(newsletterIssues)
          .where(eq(newsletterIssues.id, issueId));
        return rows[0] ?? null;
      },
    },
  };
  // The post-commit half is its own object, never derived from `deps`: that
  // disjointness is what leaves an op body no route to the live sender.
  const postDeps: AdminNewsletterPostDeps = {
    newsletterTestEmail: {
      send: (params) => {
        if (ephemeralArmedToFail) {
          return errAsync(unavailableError('armed test-send failure'));
        }
        sentTestEmails.push({ to: params.to, subject: params.subject });
        ephemeralLog.push(`email:${params.to}`);
        return okAsync();
      },
    },
  };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminNewsletterDeps, AdminNewsletterPostDeps>([
      ...adminNewsletterOperations,
    ]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    postDeps,
    executorId: `admin-newsletter-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    marker,
    wakes: (): readonly JobShard[] => jobWakes.shards(),
    sentTestEmails,
    /**
     * Iron Law projection: how many issues remain scheduled under this
     * marker. A count, not the subject list, so the projection is normalized
     * (no per-instance marker/uuid text) and therefore comparable across the
     * fresh control and op harnesses the interleaving battery spins up.
     */
    projection: async (): Promise<number> => {
      const rows = await db
        .select({ subject: newsletterIssues.subject })
        .from(newsletterIssues)
        .where(
          and(
            like(newsletterIssues.subject, `${marker}%`),
            eq(newsletterIssues.status, 'scheduled')
          )
        );
      return rows.length;
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: (): readonly string[] => [...ephemeralLog],
      armFailure: (): void => {
        ephemeralArmedToFail = true;
      },
    },
  };
}

function scheduleInput(marker: string, scheduledAt = FUTURE_ISO): Record<string, unknown> {
  return {
    subject: `${marker} issue ${crypto.randomUUID()}`,
    bodyMarkdown: '# hello\n\nnewsletter body',
    scheduledAt,
    reason: 'scheduling a test issue',
  };
}

async function seedIssue(
  marker: string,
  overrides: Partial<typeof newsletterIssues.$inferInsert> = {}
): Promise<{ id: string; subject: string }> {
  const subject = `${marker} seeded ${crypto.randomUUID()}`;
  const rows = await db
    .insert(newsletterIssues)
    .values({
      subject,
      bodyMarkdown: 'seeded body',
      status: 'scheduled',
      scheduledAt: new Date(FUTURE_ISO),
      createdBy: 'seed@hushbox.ai',
      ...overrides,
    })
    .returning({ id: newsletterIssues.id });
  const row = rows[0];
  if (row === undefined) throw new Error('newsletter harness: seed insert returned no row');
  return { id: row.id, subject };
}

type Engine = NewsletterHarness['engine'];

function execute(
  harness: NewsletterHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): ReturnType<Engine['run']> {
  return harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    role: 'operator',
    idempotencyKey: crypto.randomUUID(),
    ...(undoes === undefined ? {} : { undoes }),
  });
}

async function executeOk(
  harness: NewsletterHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): Promise<AdminOpRunResult> {
  const result = await execute(harness, name, input, undoes);
  return result._unsafeUnwrap();
}

async function issueRowById(id: string): Promise<typeof newsletterIssues.$inferSelect | null> {
  const rows = await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, id));
  return rows[0] ?? null;
}

async function dispatchJobFor(issueId: string): Promise<{ status: string } | null> {
  const rows = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.dedupeKey, `newsletter.dispatch:${issueId}`));
  return rows[0] ?? null;
}

/** Cancel's harness carries the id of the scheduled issue it seeds, so the
 * interleaving battery can target it on a fresh instance. */
interface CancelHarness extends NewsletterHarness {
  readonly seededIssueId: string;
}

/**
 * Interleaving `U₁…Uₙ` actions for the schedule/cancel pair. Scheduled-issue
 * count is not additive across identities, so each action nets to zero
 * scheduled issues under the marker (schedule-then-cancel, seed-then-cancel):
 * the op's own delta is what the Iron Law measures, and it must survive
 * unrelated newsletter churn interleaved with it.
 */
const newsletterInterleavingActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'schedule-then-cancel',
    run: async (harness): Promise<void> => {
      const nl = harness as NewsletterHarness;
      const scheduled = await executeOk(nl, 'newsletter.schedule', scheduleInput(nl.marker));
      const issueId = scheduled.inverseInput?.['issueId'];
      if (typeof issueId !== 'string') {
        throw new TypeError('newsletter interleaving: schedule returned no issueId');
      }
      await executeOk(nl, 'newsletter.cancel', { issueId, reason: 'interleaving churn cancel' });
    },
  },
  {
    name: 'seed-then-cancel',
    run: async (harness): Promise<void> => {
      const nl = harness as NewsletterHarness;
      const seeded = await seedIssue(nl.marker);
      await executeOk(nl, 'newsletter.cancel', {
        issueId: seeded.id,
        reason: 'interleaving seeded cancel',
      });
    },
  },
];

function newsletterInterleavingConfig(
  opInput: (harness: AdminOpHarnessInstance) => Record<string, unknown>
): AdminOpInterleavingConfig {
  return {
    seeds: [17, 37, 61],
    stepsPerSeed: 4,
    opInput,
    actions: newsletterInterleavingActions,
  };
}

// --- The mandatory per-op batteries ---------------------------------------

const scheduleHolder = { marker: '' };
describeAdminOp({
  contract: SCHEDULE_CONTRACT,
  createHarness: (options) => {
    const harness = createNewsletterHarness(options);
    scheduleHolder.marker = harness.marker;
    return Promise.resolve(harness);
  },
  validInput: () => scheduleInput(scheduleHolder.marker),
  invalidInput: { subject: '', bodyMarkdown: 'x', scheduledAt: FUTURE_ISO, reason: 'r' },
  interleaving: newsletterInterleavingConfig((harness) =>
    scheduleInput((harness as NewsletterHarness).marker)
  ),
});

const cancelHolder = { marker: '', issueId: '' };
describeAdminOp({
  contract: CANCEL_CONTRACT,
  createHarness: async (options): Promise<CancelHarness> => {
    const harness = createNewsletterHarness(options);
    const seeded = await seedIssue(harness.marker);
    cancelHolder.marker = harness.marker;
    cancelHolder.issueId = seeded.id;
    return { ...harness, seededIssueId: seeded.id };
  },
  validInput: () => ({ issueId: cancelHolder.issueId, reason: 'canceling the seeded issue' }),
  invalidInput: { issueId: 'not-a-uuid', reason: 'r' },
  interleaving: newsletterInterleavingConfig((harness) => ({
    issueId: (harness as CancelHarness).seededIssueId,
    reason: 'interleaving cancel',
  })),
});

const testSendHolder = { marker: '' };
describeAdminOp({
  contract: TEST_SEND_CONTRACT,
  createHarness: (options) => {
    const harness = createNewsletterHarness(options);
    testSendHolder.marker = harness.marker;
    return Promise.resolve(harness);
  },
  validInput: () => ({
    subject: `${testSendHolder.marker} preview`,
    bodyMarkdown: 'preview body',
    reason: 'previewing an issue',
  }),
  invalidInput: { subject: '', bodyMarkdown: 'x', reason: 'r' },
  hasEphemeralEffects: true,
});

// --- Semantic pins beyond the shared battery ------------------------------

describe('newsletter.schedule', () => {
  it('previews without committing an issue row or a dispatch jobs row', async () => {
    const harness = createNewsletterHarness();

    const result = await harness.engine.run({
      name: 'newsletter.schedule',
      input: scheduleInput(harness.marker),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });

    const previewed = result._unsafeUnwrap();
    const issueId = previewed.inverseInput?.['issueId'];
    if (typeof issueId !== 'string') throw new Error('preview returned no issueId');
    expect(await issueRowById(issueId)).toBeNull();
    expect(await dispatchJobFor(issueId)).toBeNull();
  });

  it('writes the scheduled issue, a pending dispatch job for it, and exactly one audit row', async () => {
    const harness = createNewsletterHarness();
    const input = scheduleInput(harness.marker);

    const executed = await executeOk(harness, 'newsletter.schedule', input);

    const issueId = executed.inverseInput?.['issueId'];
    if (typeof issueId !== 'string') throw new Error('execute returned no issueId');
    const issue = await issueRowById(issueId);
    expect(issue?.status).toBe('scheduled');
    expect(issue?.subject).toBe(input['subject']);
    expect(issue?.createdBy).toBe(harness.actor);
    expect(issue?.scheduledAt.toISOString()).toBe(FUTURE_ISO);
    const dispatchJob = await dispatchJobFor(issueId);
    expect(dispatchJob?.status).toBe('pending');
    expect(await harness.auditCount()).toBe(1);
  });

  it('leaves the bulk shard for the boundary to nudge on commit, never in preview', async () => {
    const harness = createNewsletterHarness();

    const previewed = await harness.engine.run({
      name: 'newsletter.schedule',
      input: scheduleInput(harness.marker),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);
    // Preview rolls back, so its transaction merges nothing upward: the wake
    // is now the enqueue seam's, discharged by the request boundary after the
    // response rather than by an ephemeral effect before it.
    expect(harness.wakes()).toEqual([]);

    await executeOk(harness, 'newsletter.schedule', scheduleInput(harness.marker));
    expect(harness.wakes()).toEqual(['bulk']);
  });

  it('rejects a scheduledAt in the past with no committed effect', async () => {
    const harness = createNewsletterHarness();

    const result = await execute(
      harness,
      'newsletter.schedule',
      scheduleInput(harness.marker, PAST_ISO)
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.projection()).toBe(0);
    expect(await harness.auditCount()).toBe(0);
  });
});

describe('newsletter.cancel', () => {
  it('treats canceling an already-canceled issue as a no-op success, audited', async () => {
    const harness = createNewsletterHarness();
    const seeded = await seedIssue(harness.marker);
    const input = { issueId: seeded.id, reason: 'first cancel' };
    await executeOk(harness, 'newsletter.cancel', input);

    const second = await executeOk(harness, 'newsletter.cancel', {
      issueId: seeded.id,
      reason: 'second cancel',
    });

    expect(second.effects).toEqual([
      { label: 'newsletter.issue.status', before: 'canceled', after: 'canceled' },
    ]);
    const canceledRow = await issueRowById(seeded.id);
    expect(canceledRow?.status).toBe('canceled');
    expect(await harness.auditCount()).toBe(2);
  });

  it('refuses with conflict once dispatch has begun (sending)', async () => {
    const harness = createNewsletterHarness();
    const seeded = await seedIssue(harness.marker, { status: 'sending' });

    const result = await execute(harness, 'newsletter.cancel', {
      issueId: seeded.id,
      reason: 'too late',
    });

    expect(result._unsafeUnwrapErr().code).toBe('conflict');
    const untouchedRow = await issueRowById(seeded.id);
    expect(untouchedRow?.status).toBe('sending');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an unknown issue id with not_found and no audit row', async () => {
    const harness = createNewsletterHarness();

    const result = await execute(harness, 'newsletter.cancel', {
      issueId: crypto.randomUUID(),
      reason: 'missing',
    });

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    expect(await harness.auditCount()).toBe(0);
  });

  it('round-trips: schedule → undo-cancel → redo-schedule reproduces an equivalent issue', async () => {
    const harness = createNewsletterHarness();
    const input = scheduleInput(harness.marker);

    const scheduled = await executeOk(harness, 'newsletter.schedule', input);
    const canceled = await executeOk(
      harness,
      'newsletter.cancel',
      withUndoReason(scheduled.inverseInput ?? {}, 'Legal has not cleared this issue yet.'),
      scheduled.auditId
    );
    const rescheduled = await executeOk(
      harness,
      'newsletter.schedule',
      withUndoReason(canceled.inverseInput ?? {}, 'Legal cleared it; put the issue back.'),
      canceled.auditId
    );

    const newIssueId = rescheduled.inverseInput?.['issueId'];
    if (typeof newIssueId !== 'string') throw new Error('redo returned no issueId');
    const reproduced = await issueRowById(newIssueId);
    expect(reproduced?.subject).toBe(input['subject']);
    expect(reproduced?.bodyMarkdown).toBe(input['bodyMarkdown']);
    expect(reproduced?.scheduledAt.toISOString()).toBe(FUTURE_ISO);
    expect(reproduced?.status).toBe('scheduled');
  });

  it('lets undo of a cancel fail schedule’s future gate when scheduledAt has passed', async () => {
    const harness = createNewsletterHarness();
    const seeded = await seedIssue(harness.marker, { scheduledAt: new Date(PAST_ISO) });

    const canceled = await executeOk(harness, 'newsletter.cancel', {
      issueId: seeded.id,
      reason: 'canceling a stale issue',
    });
    expect(canceled.inverseInput?.['scheduledAt']).toBe(PAST_ISO);

    const undo = await execute(
      harness,
      'newsletter.schedule',
      withUndoReason(canceled.inverseInput ?? {}, 'Cancelling this was my mistake.'),
      canceled.auditId
    );

    expect(undo._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.projection()).toBe(0);
  });
});

describe('newsletter.testSend', () => {
  it('emails the rendered preview to the acting admin and writes no issue row', async () => {
    const harness = createNewsletterHarness();

    await executeOk(harness, 'newsletter.testSend', {
      subject: `${harness.marker} preview`,
      bodyMarkdown: 'body',
      reason: 'checking the layout',
    });

    expect(harness.sentTestEmails).toEqual([
      { to: harness.actor, subject: `${harness.marker} preview` },
    ]);
    const issues = await db
      .select({ id: newsletterIssues.id })
      .from(newsletterIssues)
      .where(like(newsletterIssues.subject, `${harness.marker}%`));
    expect(issues).toEqual([]);
    expect(await harness.auditCount()).toBe(1);
  });
});

/**
 * Issue bodies whose links the email writer refuses, or which carry a user name, and the
 * forms it sends. The ops refuse the first set when the issue is written, never at send.
 */
const REFUSED_BODIES: readonly (readonly [string, string])[] = [
  ['a javascript: link', '[x](javascript:alert(1))'],
  ['a data: link', '[x](data:text/html,hi)'],
  ['a vbscript: link', '[x](vbscript:msgbox)'],
  ['a file: link', '[x](file:///etc/passwd)'],
  ['a relative link', '[x](/newsletter)'],
  ['a mailto: link with a query', '[x](mailto:a@example.test?cc=b@example.test)'],
  ['a link with a user', '[x](https://hushbox.ai@evil.test/)'],
  ['a link with a user and password', '[x](https://u:p@evil.test/)'],
  ['a reference definition to javascript:', '[x][r]\n\n[r]: javascript:alert(1)'],
  ['an autolink with a user', '<https://hushbox.ai@evil.test/>'],
  ['an image from javascript:', '![alt](javascript:alert(1))'],
  ['a link inside a heading', '## See [x](javascript:alert(1))'],
  ['a link inside bold', '**see [x](javascript:alert(1))**'],
  ['a link in a nested list', '- a\n  - [x](javascript:alert(1))'],
  ['a link in a quote', '> see [x](https://hushbox.ai@evil.test/)'],
  ['a link in a table header', '| [x](javascript:alert(1)) | b |\n| --- | --- |\n| 1 | 2 |'],
  ['a link in a table cell', '| a | b |\n| --- | --- |\n| 1 | [x](https://u@evil.test/) |'],
  [
    'an allowed image inside a refused link',
    '[![alt](https://example.test/a.png)](javascript:alert(1))',
  ],
  ['a user-name autolink inside a link label', '[a <https://u@evil.test/> b](https://ok.test)'],
  ['a javascript: link inside a link label', '[a [b](javascript:1) c](https://ok.test)'],
];

const ALLOWED_BODIES: readonly (readonly [string, string])[] = [
  ['an https: link', '[x](https://hushbox.ai/blog)'],
  ['a mailto: link to a bare address', '[x](mailto:hello@hushbox.ai)'],
  ['a bare www address', 'see www.example.test today'],
  ['raw HTML carrying a javascript: link', '<a href="javascript:alert(1)">x</a>'],
];

describe('newsletter issue links', () => {
  it.each(REFUSED_BODIES)('schedule refuses %s with no committed effect', async (_name, body) => {
    const harness = createNewsletterHarness();

    const result = await execute(harness, 'newsletter.schedule', {
      ...scheduleInput(harness.marker),
      bodyMarkdown: body,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.projection()).toBe(0);
    expect(await harness.auditCount()).toBe(0);
  });

  it.each(ALLOWED_BODIES)('schedule accepts %s', async (_name, body) => {
    const harness = createNewsletterHarness();

    const result = await execute(harness, 'newsletter.schedule', {
      ...scheduleInput(harness.marker),
      bodyMarkdown: body,
    });

    expect(result.isOk()).toBe(true);
    expect(await harness.projection()).toBe(1);
  });

  it.each(REFUSED_BODIES)('testSend refuses %s and sends nothing', async (_name, body) => {
    const harness = createNewsletterHarness();

    const result = await execute(harness, 'newsletter.testSend', {
      subject: `${harness.marker} preview`,
      bodyMarkdown: body,
      reason: 'checking the links',
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(harness.sentTestEmails).toEqual([]);
    expect(await harness.auditCount()).toBe(0);
  });

  it.each(ALLOWED_BODIES)('testSend accepts %s', async (_name, body) => {
    const harness = createNewsletterHarness();

    const result = await execute(harness, 'newsletter.testSend', {
      subject: `${harness.marker} preview`,
      bodyMarkdown: body,
      reason: 'checking the links',
    });

    expect(result.isOk()).toBe(true);
    expect(harness.sentTestEmails).toHaveLength(1);
  });
});

describe('registration', () => {
  it('registers schedule↔cancel as an inverse pair and testSend as ephemeral', () => {
    const registry = createAdminOpRegistry<AdminNewsletterDeps, AdminNewsletterPostDeps>([
      ...adminNewsletterOperations,
    ]);

    expect(registry.get('newsletter.schedule')?.contract.inverse).toBe('newsletter.cancel');
    expect(registry.get('newsletter.cancel')?.contract.inverse).toBe('newsletter.schedule');
    expect(registry.get('newsletter.testSend')?.contract.effectClass).toBe('ephemeral');
    expect(registry.list()).toHaveLength(3);
  });

  it('keeps the dispatch job type stable for the enqueue seam', () => {
    expect(NEWSLETTER_DISPATCH_JOB_TYPE).toBe('newsletter.dispatch.v1');
  });
});
