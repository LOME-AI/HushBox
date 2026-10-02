import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { chunkedWork } from './chunked.js';
import { completeOk } from './complete.js';
import { enqueueWithinTx } from './enqueue.js';
import { LEASE_TIMEOUT_ERROR } from './lease-timeout.js';
import { jobOutcome } from './outcome.js';
import { createJobExecutor } from './pass.js';
import { createJobRegistry } from './registry.js';
import { createJobWakeCollector, grantJobWakes } from './wake-capability.js';
import type { DbTransaction } from '../idempotency/transaction.js';
import type { Telemetry } from '../telemetry/index.js';
import type { ChunkResult } from './chunked.js';
import type { JobExecution, JobHandler, JobRegistry, JobShard } from './registry.js';
import type { JobWakeCapable } from './wake-capability.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * The enqueue seam demands a capability-bearing handle; nothing in this file
 * reads the wakes back, so each enqueue gets a throwaway collector.
 */
function wakeCapable(tx: DbTransaction): JobWakeCapable<DbTransaction> {
  return grantJobWakes(tx, createJobWakeCollector());
}

/**
 * These tests commit jobs rows, and every row they write carries `TYPE_PREFIX`
 * so the `afterEach` below deletes it — what this file commits does not reach
 * the next file on this worker slot's database. Positive assertions stay
 * scoped to the rows each test created; the few that read shard-wide re-arm
 * advice lean on that cleanup, since the advice is a `min(nextAttemptAt)`
 * over every row the shard holds.
 */
const TYPE_PREFIX = 'test.pass';

let typeCounter = 0;
function freshType(): string {
  typeCounter += 1;
  return `${TYPE_PREFIX}${String(typeCounter)}.v1`;
}

interface RecordedTelemetry {
  readonly port: Telemetry;
  readonly events: { msg: string; fields: Record<string, unknown> | undefined }[];
  readonly errorCodes: string[];
}

function recordingTelemetry(): RecordedTelemetry {
  const events: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
  const errorCodes: string[] = [];
  const record = (msg: string, fields?: Record<string, unknown>): void => {
    events.push({ msg, fields });
  };
  return {
    port: {
      debug: record,
      info: record,
      warn: record,
      error: record,
      captureError: (_error, errorCode) => {
        errorCodes.push(errorCode);
      },
    },
    events,
    errorCodes,
  };
}

interface ExecutorOptions {
  readonly registry: JobRegistry;
  readonly telemetry?: Telemetry;
  readonly claimantId?: string;
  readonly passBudgetMs?: number;
  /** The executor's clock, which a chunked job's budget is also measured on. */
  readonly now?: () => number;
}

function makeExecutor(options: ExecutorOptions): ReturnType<typeof createJobExecutor> {
  return createJobExecutor({
    withDb: (use) => use(db),
    registry: options.registry,
    telemetry: options.telemetry ?? recordingTelemetry().port,
    claimantId: options.claimantId ?? `claimant-${crypto.randomUUID()}`,
    random: () => 0.5,
    now: options.now ?? ((): number => Date.now()),
    passBudgetMs: options.passBudgetMs ?? 60_000,
  });
}

/**
 * An executor bound to a specific connection. The contention and latency cases
 * below need executors on their own pools — genuine SKIP LOCKED contention
 * across two Postgres sessions, and per-statement latency injected on one
 * session's connection.
 */
function createExecutor(
  dbHandle: ReturnType<typeof createDb>,
  registry: JobRegistry,
  claimantId: string
): ReturnType<typeof createJobExecutor> {
  return createJobExecutor({
    withDb: (use) => use(dbHandle),
    registry,
    telemetry: recordingTelemetry().port,
    claimantId,
    random: () => 0.5,
    now: () => Date.now(),
    passBudgetMs: 60_000,
  });
}

/** Real wall-clock delay: the wall-clock lease test waits a live lease out
 * instead of pre-aging it. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const emptyPayloadSchema = z.looseObject({});

interface RegisterOptions {
  readonly maxExecutionSeconds?: number;
  readonly maxFailures?: number;
  readonly shard?: JobShard;
}

function registryWithHandler(
  type: string,
  handler: JobHandler<Record<string, unknown>>,
  options: RegisterOptions = {}
): JobRegistry {
  const registry = createJobRegistry();
  registry.register({
    type,
    schema: emptyPayloadSchema,
    maxExecutionSeconds: options.maxExecutionSeconds ?? 60,
    maxFailures: options.maxFailures ?? 5,
    idempotency: 'natural',
    kind: 'oneShot',
    handler,
    ...(options.shard === undefined ? {} : { shard: options.shard }),
  });
  return registry;
}

function registerTxnHandler(
  registry: JobRegistry,
  type: string,
  handler: JobHandler<Record<string, unknown>>
): void {
  registry.register({
    type,
    schema: emptyPayloadSchema,
    maxExecutionSeconds: 60,
    maxFailures: 5,
    idempotency: 'txn',
    kind: 'oneShot',
    handler,
  });
}

/** The effect a txn-class test handler writes: a follow-up job row. */
function registryWithEffectType(registry: JobRegistry, effectType: string): void {
  registry.register({
    type: effectType,
    schema: emptyPayloadSchema,
    maxExecutionSeconds: 60,
    maxFailures: 5,
    idempotency: 'natural',
    kind: 'oneShot',
    handler: () => Promise.resolve(jobOutcome.ok()),
  });
}

async function enqueueCommitted(
  registry: JobRegistry,
  type: string,
  payload: unknown = {}
): Promise<string> {
  const result = await db.transaction((tx) =>
    enqueueWithinTx(wakeCapable(tx), registry, { type, payload })
  );
  if (!result.enqueued) throw new Error('expected an enqueued job');
  return result.jobId;
}

/** A chunked job's payload: units to sweep, resumed at an index. */
const chunkedPayloadSchema = z.object({
  units: z.array(z.string()),
  nextIndex: z.number().int().min(0).default(0),
});

type ChunkedPayload = z.infer<typeof chunkedPayloadSchema>;

/**
 * The smallest legal budget, so the injected clock spends it in one step and a
 * chunk boundary is a checkpoint — the cadence a real account large enough to
 * fill its budget gets.
 */
const CHUNKED_BUDGET_SECONDS = 10;

function registryWithChunkedWork(
  type: string,
  runChunk: (input: {
    readonly payload: ChunkedPayload;
    readonly cursor: number;
  }) => Promise<ChunkResult<ChunkedPayload, number>>
): JobRegistry {
  const registry = createJobRegistry();
  registry.register({
    kind: 'chunked',
    type,
    schema: chunkedPayloadSchema,
    maxExecutionSeconds: CHUNKED_BUDGET_SECONDS,
    maxFailures: 5,
    idempotency: 'natural',
    chunked: chunkedWork<ChunkedPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk,
    }),
  });
  return registry;
}

async function readJob(jobId: string): Promise<typeof jobs.$inferSelect> {
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row;
}

async function statusOf(jobId: string): Promise<string> {
  const row = await readJob(jobId);
  return row.status;
}

beforeAll(async () => {
  await db.delete(jobs).where(like(jobs.type, `${TYPE_PREFIX}%`));
});

afterEach(async () => {
  await db.delete(jobs).where(like(jobs.type, `${TYPE_PREFIX}%`));
});

afterAll(async () => {
  await db.$client.end();
});

describe('the dispatcher pass', () => {
  it('recovers a lost enqueue: a committed row whose wake was lost executes on the next pulse', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok({ done: true }));
    });
    // Commit the enqueue but deliberately send no wake — only the pulse runs.
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    // The recovery under test is row-scoped: our committed row was claimed and
    // run by the pulse alone. The pass's shard-wide advice (idle/scheduled) is
    // NOT asserted here — it is a `min(nextAttemptAt)` over the whole shared
    // `default` shard, so a foreign due-now row left on this slot's database
    // by another test file legitimately flips it to `scheduled`. That advice
    // has its own dedicated test.
    expect(executions).toBe(1);
    const row = await readJob(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ done: true });
  });

  it('dead-letters a poison job at claim without harming its batch', async () => {
    const type = freshType();
    const executedJobIds: string[] = [];
    const registry = registryWithHandler(type, (execution) => {
      executedJobIds.push(execution.jobId);
      return Promise.resolve(jobOutcome.ok());
    });
    const healthyA = await enqueueCommitted(registry, type);
    const healthyB = await enqueueCommitted(registry, type);
    const poisonId = await enqueueCommitted(registry, type);
    // A poison history: every claim crashed the isolate, none completed.
    await db.update(jobs).set({ claims: 8 }).where(eq(jobs.id, poisonId));
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(poisonId)).toBe('dead');
    expect(await statusOf(healthyA)).toBe('succeeded');
    expect(await statusOf(healthyB)).toBe('succeeded');
    expect(executedJobIds).not.toContain(poisonId);
    expect(
      telemetry.events.some(
        (event) =>
          event.msg === 'job dead-lettered at claim' && event.fields?.['jobId'] === poisonId
      )
    ).toBe(true);
    expect(telemetry.errorCodes).toContain('job_dead_letter');
  });

  it('alerts once for a mass dead-letter at claim, keeping a log line per row', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () => Promise.resolve(jobOutcome.ok()));
    const first = await enqueueCommitted(registry, type);
    const second = await enqueueCommitted(registry, type);
    // The shape a broken handler produces after a deploy: several rows reach
    // their retry ceiling and dead-letter in the same claim.
    await db
      .update(jobs)
      .set({ claims: 8 })
      .where(inArray(jobs.id, [first, second]));
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    const lines = telemetry.events.filter((event) => event.msg === 'job dead-lettered at claim');
    expect(lines.map((line) => line.fields?.['jobId'])).toEqual(
      expect.arrayContaining([first, second])
    );
    expect(lines).toHaveLength(2);
    expect(telemetry.errorCodes).toEqual(['job_dead_letter']);
  });

  it('lets a checkpoint yield consume no attempts and drains the re-pended row in the same pass', async () => {
    const type = freshType();
    const seenSteps: unknown[] = [];
    const registry = registryWithHandler(type, (execution) => {
      seenSteps.push(execution.payload['step']);
      if (execution.payload['step'] === undefined) {
        return Promise.resolve(jobOutcome.yield({ step: 2 }));
      }
      return Promise.resolve(jobOutcome.ok());
    });
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(seenSteps).toEqual([undefined, 2]);
    expect(row.status).toBe('succeeded');
    // One completed execution: the yield gave its claim increment back.
    expect(row.claims).toBe(1);
    expect(row.failures).toBe(0);
  });

  it('completes chunked work outlasting one budget across executions, none of them a failure', async () => {
    const type = freshType();
    const units = ['a', 'b', 'c'];
    const swept: string[] = [];
    let clockMs = TEST_DAY_START;
    const registry = registryWithChunkedWork(type, ({ payload, cursor }) => {
      const unit = payload.units[cursor];
      if (unit === undefined)
        return Promise.resolve({ kind: 'ok', result: { swept: swept.length } });
      swept.push(unit);
      // One chunk spends the whole budget, so the loop checkpoints after each.
      clockMs += CHUNKED_BUDGET_SECONDS * 1000;
      return Promise.resolve({ kind: 'advance', cursor: cursor + 1 });
    });
    const jobId = await enqueueCommitted(registry, type, { units });
    // One execution per pass, so the row's state between them is observable.
    const executor = makeExecutor({ registry, passBudgetMs: 0, now: () => clockMs });

    const states: { status: string; failures: number }[] = [];
    for (let pass = 1; pass <= units.length + 2; pass += 1) {
      await executor.runPass('default');
      const row = await readJob(jobId);
      states.push({ status: row.status, failures: row.failures });
      if (row.status === 'succeeded') break;
    }

    expect(swept).toEqual(units);
    const intermediate = states.slice(0, -1);
    expect(intermediate.length).toBeGreaterThan(0);
    for (const state of intermediate) {
      expect(state).toEqual({ status: 'pending', failures: 0 });
    }
    expect(states.at(-1)).toEqual({ status: 'succeeded', failures: 0 });
  });

  it('lands a cancel requested mid-chunk at the next chunk boundary', async () => {
    const type = freshType();
    let chunks = 0;
    let clockMs = TEST_DAY_START;
    let jobId = '';
    const registry = registryWithChunkedWork(type, async ({ cursor }) => {
      chunks += 1;
      // The cancel arrives while this chunk runs, as an operator's would.
      await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, jobId));
      clockMs += CHUNKED_BUDGET_SECONDS * 1000;
      return { kind: 'advance', cursor: cursor + 1 };
    });
    jobId = await enqueueCommitted(registry, type, { units: ['a', 'b', 'c'] });

    await makeExecutor({ registry, now: () => clockMs }).runPass('default');

    // The checkpoint the loop wrote carries the cancel; no second chunk ran.
    expect(chunks).toBe(1);
    expect(await statusOf(jobId)).toBe('cancelled');
  });

  it('fails a hung handler at its lease timeout without eating the pass, and fences out its late writes', async () => {
    const hungType = freshType();
    const quickType = freshType();
    let capturedExecution: JobExecution<Record<string, unknown>> | undefined;
    const registry = createJobRegistry();
    registry.register({
      type: hungType,
      schema: emptyPayloadSchema,
      maxExecutionSeconds: 10,
      maxFailures: 5,
      idempotency: 'natural',
      kind: 'oneShot',
      handler: (execution) => {
        capturedExecution = execution;
        return new Promise(() => {});
      },
    });
    let quickExecutions = 0;
    registry.register({
      type: quickType,
      schema: emptyPayloadSchema,
      maxExecutionSeconds: 60,
      maxFailures: 5,
      idempotency: 'natural',
      kind: 'oneShot',
      handler: () => {
        quickExecutions += 1;
        return Promise.resolve(jobOutcome.ok());
      },
    });
    const claimantId = `claimant-${crypto.randomUUID()}`;
    const hungId = await enqueueCommitted(registry, hungType);
    const quickId = await enqueueCommitted(registry, quickType);
    // The kill follows the row's lease, so shortening it is what keeps this
    // case inside a test's window without declaring an unsafely small budget.
    await db.update(jobs).set({ leaseSeconds: 6 }).where(eq(jobs.id, hungId));
    await makeExecutor({ registry, claimantId }).runPass('default');

    expect(quickExecutions).toBe(1);
    expect(await statusOf(quickId)).toBe('succeeded');
    const hungRow = await readJob(hungId);
    expect(hungRow.status).toBe('pending');
    expect(hungRow.failures).toBe(1);
    expect(hungRow.errors[0]?.error).toBe(LEASE_TIMEOUT_ERROR);

    // The losing handler is now a zombie: the terminal write it still holds
    // and any late completion against its fence both miss the row.
    if (capturedExecution === undefined) throw new Error('hung handler never started');
    await expect(capturedExecution.completeWithinTx(db)).rejects.toThrow('zombie');
    expect(
      await completeOk(db, { jobId: hungId, claimedBy: claimantId, claims: 1 }, { late: true })
    ).toBe('lost');
    expect(await statusOf(hungId)).toBe('pending');
  });

  it('leaves an executing handler its row: a concurrent pass reclaims nothing before the lease expires', async () => {
    // A row's lease is its handler's budget plus the reclaim margin, so a live
    // execution is never concurrently claimable. Budget and margin are real
    // seconds here — a second dispatcher runs against the live row rather than
    // against a fabricated timestamp.
    const type = freshType();
    const budgetSeconds = 10;
    let started: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = registryWithHandler(
      type,
      async () => {
        started();
        await released;
        return jobOutcome.ok();
      },
      { maxExecutionSeconds: budgetSeconds }
    );
    const firstClaimant = `claimant-${crypto.randomUUID()}`;
    const jobId = await enqueueCommitted(registry, type);

    const firstPass = makeExecutor({ registry, claimantId: firstClaimant }).runPass('default');
    await handlerStarted;
    const claimed = await readJob(jobId);
    // A second dispatcher passes over the row while its handler is still alive.
    await makeExecutor({ registry, claimantId: `claimant-${crypto.randomUUID()}` }).runPass(
      'default'
    );
    const contested = await readJob(jobId);

    expect(claimed.leaseSeconds).toBe(15);
    expect(claimed.status).toBe('running');
    expect(contested.status).toBe('running');
    expect(contested.claimedBy).toBe(claimed.claimedBy);
    expect(contested.claims).toBe(1);

    // The handler then finishes on the claim it never lost.
    release();
    await firstPass;
    expect(await statusOf(jobId)).toBe('succeeded');
  });

  it('kills at the row’s own implied budget when the registration has been raised past it', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () => new Promise<never>(() => {}), {
      maxExecutionSeconds: 60,
    });
    const jobId = await enqueueCommitted(registry, type);
    // The row as an older, smaller budget left it: the lease a 1 s budget derives.
    await db.update(jobs).set({ leaseSeconds: 6 }).where(eq(jobs.id, jobId));

    const startedAt = Date.now();
    await makeExecutor({ registry }).runPass('default');
    const elapsedMs = Date.now() - startedAt;

    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(row.failures).toBe(1);
    expect(row.errors[0]?.error).toContain('lease timeout');
    // The registration's 60 s budget would not have fired inside this window,
    // so the kill can only have come from the row's own lease.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('leaves a positive budget to a row at the smallest declarable budget whose lease predates the margin', async () => {
    // The case the margin has to survive: the smallest budget the registry
    // accepts, on a row stamped under the scheme where the authored number was
    // the lease itself. A margin as large as such a budget would floor the
    // timer to zero and kill the handler before it ran.
    const smallestBudget = 10;
    const type = freshType();
    const registry = registryWithHandler(type, () => new Promise<never>(() => {}), {
      maxExecutionSeconds: smallestBudget,
    });
    const jobId = await enqueueCommitted(registry, type);
    await db.update(jobs).set({ leaseSeconds: smallestBudget }).where(eq(jobs.id, jobId));

    const startedAt = Date.now();
    await makeExecutor({ registry }).runPass('default');
    const elapsedMs = Date.now() - startedAt;

    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(row.errors[0]?.error).toContain('lease timeout');
    // Positive: the handler got real execution time rather than being killed on
    // the next macrotask. Strictly inside the row's own lease: the reclaim
    // window never opened while it ran.
    expect(elapsedMs).toBeGreaterThan(3000);
    expect(elapsedMs).toBeLessThan(smallestBudget * 1000);
  });

  it('resolves cancel-vs-claim: a cancel requested before the pass cancels the job un-run', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok());
    });
    const jobId = await enqueueCommitted(registry, type);
    await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, jobId));
    await makeExecutor({ registry }).runPass('default');
    expect(executions).toBe(0);
    expect(await statusOf(jobId)).toBe('cancelled');
  });

  it('resolves cancel-vs-checkpoint: a cancel landing mid-execution settles at the yield boundary', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, async (execution) => {
      executions += 1;
      await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, execution.jobId));
      return jobOutcome.yield({ step: 2 });
    });
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    expect(executions).toBe(1);
    expect(await statusOf(jobId)).toBe('cancelled');
  });

  it('re-claims a lease-expired running row', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok());
    });
    const jobId = await enqueueCommitted(registry, type);
    // A claimant died mid-job: running, lease long expired, no completion.
    await db
      .update(jobs)
      .set({
        status: 'running',
        claims: 1,
        claimedAt: sql`now() - interval '120 seconds'`,
        claimedBy: 'dead-claimant',
      })
      .where(eq(jobs.id, jobId));
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(executions).toBe(1);
    expect(row.status).toBe('succeeded');
    expect(row.claims).toBe(2);
  });

  it('redrives a dead job through an explicit update', async () => {
    const type = freshType();
    let attempts = 0;
    const registry = registryWithHandler(type, () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? jobOutcome.dead('deterministic-validation-error') : jobOutcome.ok()
      );
    });
    const jobId = await enqueueCommitted(registry, type);
    const executor = makeExecutor({ registry });
    await executor.runPass('default');
    expect(await statusOf(jobId)).toBe('dead');
    // The explicit admin redrive: dead rows are rows, revived by UPDATE.
    await db
      .update(jobs)
      .set({ status: 'pending', claims: 0, failures: 0, nextAttemptAt: sql`now()` })
      .where(eq(jobs.id, jobId));
    await executor.runPass('default');
    expect(await statusOf(jobId)).toBe('succeeded');
    expect(attempts).toBe(2);
  });

  it('re-pends a failed job and advises the exact backoff as the next alarm', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.fail('gateway-5xx'))
    );
    const jobId = await enqueueCommitted(registry, type);
    const result = await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(row.failures).toBe(1);
    expect(row.errors[0]).toMatchObject({ claim: 1, error: 'gateway-5xx' });
    // failures=1 with centered jitter → 1s backoff; the pass advises it.
    expect(result.kind).toBe('scheduled');
    if (result.kind === 'scheduled') {
      expect(result.delayMs).toBeGreaterThanOrEqual(250);
      expect(result.delayMs).toBeLessThanOrEqual(1000);
    }
  });

  it('re-pends a throwing handler as a failure', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () => Promise.reject(new Error('handler exploded')));
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(row.failures).toBe(1);
    expect(row.errors[0]?.error).toBe('handler exploded');
  });

  it('records a non-Error throw stringified in the error history', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection path is the behavior under test
      Promise.reject('string-rejection')
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.errors[0]?.error).toBe('string-rejection');
  });

  it('returns due when the pass budget is exhausted with work remaining', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.yield({ again: true }))
    );
    await enqueueCommitted(registry, type);
    const result = await makeExecutor({ registry, passBudgetMs: 0 }).runPass('default');
    expect(result).toEqual({ kind: 'due' });
  });

  // The shard-global re-arm advice (`idle` when the whole shard has no
  // pending/scheduled work; `scheduled` at the exact `min(nextAttemptAt)`) is a
  // property of ALL rows on the shared `default` shard, which foreign production
  // rows committed by other test files (`payment.verify.v1` at admission) can
  // legitimately hold — so it is not a stable observation against the live DB.
  // That advice mapping is covered against a controlled (foreign-row-free) DB in
  // the `pass.test.ts` unit suite instead. The scheduled branch also has a
  // live-DB witness above ("re-pends a failed job and advises the exact
  // backoff"), whose assertion band tolerates a foreign due-now row.

  it('dead-letters an unregistered job type with a distinct code', async () => {
    const knownType = freshType();
    const registry = registryWithHandler(knownType, () => Promise.resolve(jobOutcome.ok()));
    const rows = await db
      .insert(jobs)
      .values({
        type: `${TYPE_PREFIX}unknown.v1`,
        payload: {},
        maxClaims: 8,
        maxFailures: 5,
        leaseSeconds: 60,
      })
      .returning({ id: jobs.id });
    const jobId = rows[0]?.id;
    if (jobId === undefined) throw new Error('insert failed');
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('dead');
    expect(row.errors[0]?.error).toBe('unregistered job type');
  });

  it('dead-letters an unparseable payload with a distinct code', async () => {
    const type = freshType();
    const registry = createJobRegistry();
    let executions = 0;
    registry.register({
      type,
      schema: z.object({ userId: z.string() }),
      maxExecutionSeconds: 60,
      maxFailures: 5,
      idempotency: 'natural',
      kind: 'oneShot',
      handler: () => {
        executions += 1;
        return Promise.resolve(jobOutcome.ok());
      },
    });
    const rows = await db
      .insert(jobs)
      .values({ type, payload: { userId: 42 }, maxClaims: 8, maxFailures: 5, leaseSeconds: 60 })
      .returning({ id: jobs.id });
    const jobId = rows[0]?.id;
    if (jobId === undefined) throw new Error('insert failed');
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(executions).toBe(0);
    expect(row.status).toBe('dead');
    expect(row.errors[0]?.error).toBe('payload failed its registered schema');
  });

  it('alerts once for a batch of unregistered types, keeping a log line per job', async () => {
    const registry = registryWithHandler(freshType(), () => Promise.resolve(jobOutcome.ok()));
    const unknownType = `${TYPE_PREFIX}massunknown.v1`;
    const rows = await db
      .insert(jobs)
      .values([
        { type: unknownType, payload: {}, maxClaims: 8, maxFailures: 5, leaseSeconds: 60 },
        { type: unknownType, payload: {}, maxClaims: 8, maxFailures: 5, leaseSeconds: 60 },
      ])
      .returning({ id: jobs.id });
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    const lines = telemetry.events.filter(
      (event) => event.msg === 'job dead-lettered: unregistered type'
    );
    expect(lines.map((line) => line.fields?.['jobId'])).toEqual(
      expect.arrayContaining(rows.map((row) => row.id))
    );
    expect(lines).toHaveLength(2);
    expect(telemetry.errorCodes).toEqual(['job_dead_letter']);
  });

  it('alerts once for a batch of unparseable payloads, keeping a log line per job', async () => {
    const type = freshType();
    const registry = createJobRegistry();
    registry.register({
      type,
      schema: z.object({ userId: z.string() }),
      maxExecutionSeconds: 60,
      maxFailures: 5,
      idempotency: 'natural',
      kind: 'oneShot',
      handler: () => Promise.resolve(jobOutcome.ok()),
    });
    const rows = await db
      .insert(jobs)
      .values([
        { type, payload: { userId: 42 }, maxClaims: 8, maxFailures: 5, leaseSeconds: 60 },
        { type, payload: { userId: 43 }, maxClaims: 8, maxFailures: 5, leaseSeconds: 60 },
      ])
      .returning({ id: jobs.id });
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    const lines = telemetry.events.filter(
      (event) => event.msg === 'job dead-lettered: unparseable payload'
    );
    expect(lines.map((line) => line.fields?.['jobId'])).toEqual(
      expect.arrayContaining(rows.map((row) => row.id))
    );
    expect(lines).toHaveLength(2);
    expect(telemetry.errorCodes).toEqual(['job_dead_letter']);
  });

  it('alerts once for a batch its handler dead-letters, keeping a log line per job', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.dead('deterministic-validation-error'))
    );
    const first = await enqueueCommitted(registry, type);
    const second = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(first)).toBe('dead');
    expect(await statusOf(second)).toBe('dead');
    const lines = telemetry.events.filter(
      (event) => event.msg === 'job dead-lettered by its handler'
    );
    expect(lines.map((line) => line.fields?.['jobId'])).toEqual(
      expect.arrayContaining([first, second])
    );
    expect(lines).toHaveLength(2);
    expect(telemetry.errorCodes).toEqual(['job_dead_letter']);
  });

  it('logs and discards a completion that lost the fence', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, async (execution) => {
      // A rival reclaim while this handler runs: the claim counter moves on.
      await db
        .update(jobs)
        .set({ claims: sql`${jobs.claims} + 1` })
        .where(eq(jobs.id, execution.jobId));
      return jobOutcome.ok();
    });
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(jobId)).toBe('running');
    expect(
      telemetry.events.some(
        (event) =>
          event.msg === 'job completion lost the fence' && event.fields?.['jobId'] === jobId
      )
    ).toBe(true);
  });

  it('emits telemetry when a completion write fails after the handler ran', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      // A jsonb-unserializable result: the completion write itself rejects.
      Promise.resolve(jobOutcome.ok({ poison: 1n }))
    );
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(
      telemetry.events.some(
        (event) => event.msg === 'job completion write failed' && event.fields?.['jobId'] === jobId
      )
    ).toBe(true);
    expect(telemetry.errorCodes).toContain('job_completion_write_failed');
  });

  it('leaves a job whose completion write failed claimed for lease recovery', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.ok({ poison: 1n }))
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    expect(await statusOf(jobId)).toBe('running');
  });

  it('commits a txn-class handler effect with its completion in one transaction', async () => {
    const type = freshType();
    const effectType = freshType();
    const registry = createJobRegistry();
    registryWithEffectType(registry, effectType);
    registerTxnHandler(registry, type, (execution) =>
      db.transaction(async (tx) => {
        await enqueueWithinTx(wakeCapable(tx), registry, { type: effectType, payload: {} });
        return execution.completeWithinTx(tx, { settled: true });
      })
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ settled: true });
    const effects = await db.select().from(jobs).where(eq(jobs.type, effectType));
    expect(effects).toHaveLength(1);
  });

  it('skips the executor terminal write after a handler self-completion', async () => {
    const type = freshType();
    const registry = createJobRegistry();
    registerTxnHandler(registry, type, (execution) =>
      db.transaction((tx) => execution.completeWithinTx(tx, { settled: true }))
    );
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(jobId)).toBe('succeeded');
    // A redundant executor write would miss the consumed fence and pollute
    // the genuine zombie signal with this warning.
    expect(telemetry.events.some((event) => event.msg === 'job completion lost the fence')).toBe(
      false
    );
  });

  it('rolls back a txn-class effect with its terminal transition when the handler crashes before commit', async () => {
    const type = freshType();
    const effectType = freshType();
    const registry = createJobRegistry();
    registryWithEffectType(registry, effectType);
    registerTxnHandler(registry, type, (execution) =>
      db.transaction(async (tx) => {
        await enqueueWithinTx(wakeCapable(tx), registry, { type: effectType, payload: {} });
        await execution.completeWithinTx(tx, { settled: true });
        throw new Error('crash-before-commit');
      })
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    // Neither the effect nor the terminal transition persisted; the row
    // re-pends through the ordinary failure path and stays retryable.
    expect(await db.select().from(jobs).where(eq(jobs.type, effectType))).toHaveLength(0);
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
    expect(row.failures).toBe(1);
    expect(row.errors[0]?.error).toBe('crash-before-commit');
  });

  it('aborts a txn-class completion that lost the fence so the effect cannot commit', async () => {
    const type = freshType();
    const effectType = freshType();
    const registry = createJobRegistry();
    registryWithEffectType(registry, effectType);
    let thrownInHandler: unknown;
    registerTxnHandler(registry, type, async (execution) => {
      // A rival reclaim while this handler runs: the claim counter moves on.
      await db
        .update(jobs)
        .set({ claims: sql`${jobs.claims} + 1` })
        .where(eq(jobs.id, execution.jobId));
      try {
        return await db.transaction(async (tx) => {
          await enqueueWithinTx(wakeCapable(tx), registry, { type: effectType, payload: {} });
          return await execution.completeWithinTx(tx, { settled: true });
        });
      } catch (error) {
        thrownInHandler = error;
        throw error;
      }
    });
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(String(thrownInHandler)).toContain('fence');
    expect(await db.select().from(jobs).where(eq(jobs.type, effectType))).toHaveLength(0);
    expect(await statusOf(jobId)).toBe('running');
    expect(telemetry.events.some((event) => event.msg === 'job completion lost the fence')).toBe(
      true
    );
  });

  it('claims each job exactly once across two concurrent dispatchers', async () => {
    const type = freshType();
    const executionsByJob = new Map<string, number>();
    const registry = registryWithHandler(type, (execution) => {
      executionsByJob.set(execution.jobId, (executionsByJob.get(execution.jobId) ?? 0) + 1);
      return Promise.resolve(jobOutcome.ok());
    });
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => enqueueCommitted(registry, type))
    );
    await Promise.all([
      makeExecutor({ registry, claimantId: 'claimant-a' }).runPass('default'),
      makeExecutor({ registry, claimantId: 'claimant-b' }).runPass('default'),
    ]);
    for (const jobId of ids) {
      expect(executionsByJob.get(jobId)).toBe(1);
      expect(await statusOf(jobId)).toBe('succeeded');
    }
  });

  it('never double-claims a row when two dispatchers on separate connections contend', async () => {
    // The exactly-once test above shares this file's single max:1 pool,
    // so its two executors serialize on one Postgres session — the claim SQL's
    // FOR UPDATE SKIP LOCKED is never truly contended. Here each dispatcher
    // gets its OWN connection, so two live sessions race the same rows and the
    // lock-skip is what keeps every row claimed exactly once.
    const type = freshType();
    const executionsByJob = new Map<string, number>();
    const registry = registryWithHandler(type, (execution) => {
      executionsByJob.set(execution.jobId, (executionsByJob.get(execution.jobId) ?? 0) + 1);
      return Promise.resolve(jobOutcome.ok());
    });
    const dbA = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const dbB = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    try {
      const ids = await Promise.all(
        Array.from({ length: 6 }, () => enqueueCommitted(registry, type))
      );
      await Promise.all([
        createExecutor(dbA, registry, 'claimant-a').runPass('default'),
        createExecutor(dbB, registry, 'claimant-b').runPass('default'),
      ]);
      for (const jobId of ids) {
        expect(executionsByJob.get(jobId)).toBe(1);
        expect(await statusOf(jobId)).toBe('succeeded');
      }
    } finally {
      await dbA.$client.end();
      await dbB.$client.end();
    }
  });

  it('claims and executes correctly under injected per-statement DB latency', async () => {
    // createDb's injectLatencyMs delays every statement, standing in for
    // real Neon's per-statement latency that the local wsproxy's ~0 ms round
    // trips hide. The real claim→execute→complete path must still settle the
    // row exactly once with the delay on every statement of the pass.
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok({ done: true }));
    });
    const jobId = await enqueueCommitted(registry, type);
    const slowDb = createDb(DATABASE_URL, {
      neonDev: LOCAL_NEON_DEV_CONFIG,
      injectLatencyMs: 40,
    });
    try {
      await createExecutor(slowDb, registry, `claimant-${crypto.randomUUID()}`).runPass('default');
    } finally {
      await slowDb.$client.end();
    }
    const row = await readJob(jobId);
    expect(executions).toBe(1);
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ done: true });
  });

  it('reclaims a running row whose short lease expired by real elapsed wall-clock time', async () => {
    // The reclaim test above pre-ages claimedAt by 120 s. Here the row is
    // claimed at now() with a 1 s lease, so the lease crosses its threshold only
    // because the test actually waits past it — the wall-clock lease path, not a
    // fabricated past timestamp. All lease math runs on the database clock.
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(
      type,
      () => {
        executions += 1;
        return Promise.resolve(jobOutcome.ok());
      },
      { maxExecutionSeconds: 10 }
    );
    const jobId = await enqueueCommitted(registry, type);
    // A claimant died mid-job: running now, a 1 s lease, no completion.
    await db
      .update(jobs)
      .set({
        status: 'running',
        claims: 1,
        claimedAt: sql`now()`,
        claimedBy: 'dead-claimant',
        leaseSeconds: 1,
      })
      .where(eq(jobs.id, jobId));
    // The lease is still live: a pass now must leave the row to its claimant.
    await makeExecutor({ registry }).runPass('default');
    expect(executions).toBe(0);
    expect(await statusOf(jobId)).toBe('running');
    // Wait out the lease in real wall-clock time; the row is now reclaimable.
    await realSleep(1300);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(executions).toBe(1);
    expect(row.status).toBe('succeeded');
    expect(row.claims).toBe(2);
  });
});
