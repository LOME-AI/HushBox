import { Redis } from '@upstash/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  DB_CONNECT_TIMEOUT_MS,
  LOCAL_NEON_DEV_CONFIG,
  SERIAL_POOL_OVERLAP_ERROR_NAME,
  createDb,
  jobs,
} from '@hushbox/db';
import { createScratchBucket } from '../slices/media/adapters/test-fixtures.js';
import { writeThroughSnapshot } from '../slices/billing/index.js';
import { BILLING_KEYS } from '../slices/billing/domain/keys.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
} from '../slices/models/domain/catalog/gateway-fixtures.js';
import {
  collectJobWake,
  createJobWakeCollector,
  grantJobWakes,
  runCronEntries,
} from '../lib/jobs/index.js';
import { runSettlement } from '../lib/idempotency/index.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import { ADMIN_DIGEST_JOB_TYPE } from '../slices/admin/index.js';
import {
  DAILY_RETENTION_CRON,
  createScheduledHandler,
  HOURLY_MAINTENANCE_CRON,
  JOBS_HEALTH_CRON,
  cronEntriesFor,
  productionScheduledRuntime,
} from '../scheduled.js';
import type { Database } from '@hushbox/db';
import type { CronEntry, JobDispatcherNamespace } from '../lib/jobs/index.js';
import type { ScheduleCheckIn } from '../lib/telemetry/check-in.js';
import type { SafeLogFields, Telemetry } from '../lib/telemetry/index.js';
import type { CronDependencies, ScheduledBindings, ScheduledRuntime } from '../scheduled.js';
import type { ScratchBucket } from '../slices/media/adapters/test-fixtures.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for scheduled integration tests — run via pnpm test:api`);
  }
  return value;
}

// The production cron handle itself, so a live pass meets the serial pool's
// refusal of an overlapping statement exactly where a deployed pass would.
const db = grantJobWakes(
  productionScheduledRuntime.createDb({ ...process.env } as ScheduledBindings),
  createJobWakeCollector()
);
const redis = new Redis({
  url: requireEnv('UPSTASH_REDIS_REST_URL'),
  token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
});

interface TelemetryRecorder {
  readonly telemetry: Telemetry & ScheduleCheckIn;
  readonly captured: string[];
  readonly capturedErrors: Error[];
}

function recordingTelemetry(): TelemetryRecorder {
  const captured: string[] = [];
  const capturedErrors: Error[] = [];
  const telemetry: Telemetry & ScheduleCheckIn = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (_msg: string, _fields?: SafeLogFields) => {},
    captureError: (error, code: string) => {
      captured.push(code);
      capturedErrors.push(error);
    },
    checkIn: () => {},
  };
  return { telemetry, captured, capturedErrors };
}

let scratch: ScratchBucket;

beforeAll(async () => {
  scratch = await createScratchBucket();
});

afterAll(async () => {
  await scratch.destroy();
  await db.$client.end();
});

/**
 * Live-infra deps: real Postgres/Redis/MinIO, the gateway replayed by
 * fixture (an empty catalog — CI never makes a live AI call), and the GC
 * sweep pointed at an isolated scratch bucket (age-based sweeps must never
 * share the dev bucket).
 */
function liveDeps(telemetry: Telemetry): CronDependencies {
  return {
    env: { ...process.env, R2_BUCKET_MEDIA: scratch.bucket } as ScheduledBindings,
    db,
    redis,
    telemetry,
    now: () => new Date(),
    isCI: false,
    catalogFetch: catalogFetch({ models: [], zdrModelIds: [] }),
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    refreshJitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
  };
}

/**
 * Every daily pass genuinely enqueues the digest row, and it commits — so it
 * outlives this file on the worker slot's database, where a row from an
 * earlier day is old enough to be the oldest stuck job the health probe reads
 * unfiltered. Each daily case clears the rows it left and asserts it left one.
 */
async function clearDigestRows(): Promise<number> {
  const cleared = await db
    .delete(jobs)
    .where(eq(jobs.type, ADMIN_DIGEST_JOB_TYPE))
    .returning({ id: jobs.id });
  return cleared.length;
}

describe('the hourly maintenance pass', () => {
  it('runs the poller and every auditor against live infra without an entry failure', async () => {
    // A seeded snapshot guarantees the drift auditor walks at least one
    // wallet (the comparison path, not just the empty scan).
    const walletId = crypto.randomUUID();
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 1n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    const recorder = recordingTelemetry();
    let anyFailed: boolean;
    try {
      const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, liveDeps(recorder.telemetry));
      if (entries === undefined) throw new Error('hourly cron mapped no entries');
      ({ anyFailed } = await runCronEntries(entries, recorder.telemetry));
    } finally {
      await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
    }
    // Ambient dev data may legitimately page an auditor; what must never
    // appear is an entry-level failure.
    expect(anyFailed).toBe(false);
  });

  it('threads the flush-capable cron telemetry into media-GC, never the flush-less env fallback', async () => {
    // In production the cron telemetry is the only flush-capable one
    // (createTelemetry wires scheduleFlush to ctx.waitUntil); the media-GC env
    // fallback (createRequestTelemetry(env), built eagerly inside
    // productionMediaGcDeps) has no scheduleFlush, so a captured GC delete
    // failure would never flush in the frozen cron isolate — the defect.
    //
    // Deterministic proof that the injected cron telemetry is threaded rather
    // than that fallback: run the real hourly wiring with TELEMETRY_SINKS
    // stripped from env. The env fallback throws 'TELEMETRY_SINKS is missing'
    // at dep construction; threading the supplied telemetry bypasses it and the
    // empty scratch-bucket sweep completes.
    const recorder = recordingTelemetry();
    const deps = liveDeps(recorder.telemetry);
    delete (deps.env as { TELEMETRY_SINKS?: string }).TELEMETRY_SINKS;
    const mediaGc = cronEntriesFor(HOURLY_MAINTENANCE_CRON, deps)?.find(
      (entry) => entry.name === 'media-gc'
    );
    if (mediaGc === undefined) throw new Error('hourly cron mapped no media-gc entry');
    await expect(mediaGc.run()).resolves.toBeUndefined();
  });
});

describe('the daily retention pass', () => {
  it('runs both retention deletes against live Postgres without an entry failure', async () => {
    const recorder = recordingTelemetry();
    const entries = cronEntriesFor(DAILY_RETENTION_CRON, liveDeps(recorder.telemetry));
    if (entries === undefined) throw new Error('daily cron mapped no entries');
    const { anyFailed } = await runCronEntries(entries, recorder.telemetry);
    expect(anyFailed).toBe(false);
    expect(await clearDigestRows()).toBeGreaterThanOrEqual(1);
  });
});

describe('the jobs-health pass', () => {
  it('probes the live jobs table without an entry failure', async () => {
    const recorder = recordingTelemetry();
    const entries = cronEntriesFor(JOBS_HEALTH_CRON, liveDeps(recorder.telemetry));
    if (entries === undefined) throw new Error('jobs-health cron mapped no entries');
    const { anyFailed } = await runCronEntries(entries, recorder.telemetry);
    expect(anyFailed).toBe(false);
  });
});

/**
 * A pass through the production runtime's own database handle, with the
 * entries the test chooses; telemetry and Redis are the test's.
 */
function productionDbRuntime(
  recorder: TelemetryRecorder,
  entriesFor: ScheduledRuntime['entriesFor']
): ScheduledRuntime {
  return {
    createDb: (env) => productionScheduledRuntime.createDb(env),
    createRedis: () => redis,
    createTelemetry: () => recorder.telemetry,
    entriesFor,
  };
}

/** Holds the pass's connection past the deadline on acquiring it. */
function slowFirstStatementEntry(passDb: Database): CronEntry {
  const seconds = DB_CONNECT_TIMEOUT_MS / 1000 + 0.5;
  return {
    name: 'slow-first-statement',
    run: async () => {
      await passDb.execute(sql`select pg_sleep(${seconds})`);
    },
  };
}

describe('a pass whose first statement outlasts the connection-acquire deadline', () => {
  it('runs the jobs-health entries after it without a capture', async () => {
    const recorder = recordingTelemetry();
    await createScheduledHandler(
      productionDbRuntime(recorder, (cron, deps) => [
        slowFirstStatementEntry(deps.db),
        ...(cronEntriesFor(cron, deps) ?? []),
      ])
    )({ cron: JOBS_HEALTH_CRON }, { ...process.env } as ScheduledBindings, {
      waitUntil: () => {},
    });
    expect(recorder.captured).toEqual([]);
  });
});

/** The `name` of every link in an error's cause chain, outermost first. */
function causeChainNames(error: Error | undefined): string[] {
  const names: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    names.push(current.name);
    current = current.cause;
  }
  return names;
}

describe('an entry that issues two statements at once on the pass handle', () => {
  it('is captured whole as the entry failure, the serial pool refusal in its cause chain', async () => {
    const recorder = recordingTelemetry();
    await createScheduledHandler(
      productionDbRuntime(recorder, (_cron, deps) => [
        {
          name: 'overlapping-statements',
          run: async () => {
            await Promise.all([
              deps.db.execute(sql`select 1 as one`),
              deps.db.execute(sql`select 1 as one`),
            ]);
          },
        },
      ])
    )({ cron: JOBS_HEALTH_CRON }, { ...process.env } as ScheduledBindings, {
      waitUntil: () => {},
    });
    expect(recorder.captured).toEqual([FINGERPRINT_CODES.cronEntryFailed]);
    expect(causeChainNames(recorder.capturedErrors[0])).toContain(SERIAL_POOL_OVERLAP_ERROR_NAME);
  });

  it('leaves the next entry to run', async () => {
    const ran: string[] = [];
    await createScheduledHandler(
      productionDbRuntime(recordingTelemetry(), (_cron, deps) => [
        {
          name: 'overlapping-statements',
          run: async () => {
            await Promise.all([
              deps.db.execute(sql`select 1 as one`),
              deps.db.execute(sql`select 1 as one`),
            ]);
          },
        },
        {
          name: 'next-entry',
          run: () => {
            ran.push('next-entry');
            return Promise.resolve();
          },
        },
      ])
    )({ cron: JOBS_HEALTH_CRON }, { ...process.env } as ScheduledBindings, {
      waitUntil: () => {},
    });
    expect(ran).toEqual(['next-entry']);
  });
});

/** The two codes the cron runner files a failed entry under, and only it files in a pass. */
const ENTRY_FAILURE_CODES: ReadonlySet<string> = new Set([
  FINGERPRINT_CODES.cronEntryFailed,
  FINGERPRINT_CODES.dependencyUnavailable,
]);

/**
 * The production runtime whole, its own telemetry wrapped to record every
 * capture code before passing the capture on.
 */
function captureRecordingProductionRuntime(captured: string[]): ScheduledRuntime {
  return {
    ...productionScheduledRuntime,
    createTelemetry: (env, ctx) => {
      const telemetry = productionScheduledRuntime.createTelemetry(env, ctx);
      return {
        ...telemetry,
        captureError: (error, code) => {
          captured.push(code);
          telemetry.captureError(error, code);
        },
      };
    },
  };
}

describe('createScheduledHandler over the production runtime, end to end (the exported scheduledHandler binding is exercised by e2e/api/cron.spec.ts)', () => {
  it('executes a daily retention trigger against the live stack without an entry failure', async () => {
    const captured: string[] = [];
    const env = { ...process.env, TELEMETRY_SINKS: 'console' } as ScheduledBindings;
    await expect(
      createScheduledHandler(captureRecordingProductionRuntime(captured))(
        { cron: DAILY_RETENTION_CRON },
        env,
        { waitUntil: () => {} }
      )
    ).resolves.toBeUndefined();
    expect(await clearDigestRows()).toBeGreaterThanOrEqual(1);
    expect(captured.filter((code) => ENTRY_FAILURE_CODES.has(code))).toEqual([]);
  });
});

interface RecordingDispatcher {
  readonly namespace: JobDispatcherNamespace<string>;
  readonly woken: string[];
}

/** Stands in for the dispatcher DO binding, recording which shards were nudged. */
function recordingDispatcher(): RecordingDispatcher {
  const woken: string[] = [];
  return {
    namespace: {
      idFromName: (name: string): string => name,
      get: (id: string) => ({
        fetch: (): Promise<unknown> => {
          woken.push(id);
          return Promise.resolve();
        },
      }),
    },
    woken,
  };
}

/**
 * A cron pass whose single entry opens one transaction and collects a wake in
 * it — the shape every enqueueing entry has once the enqueue records its own.
 */
function wakeProbeRuntime(client: Database, outcome: 'commit' | 'abort'): ScheduledRuntime {
  return {
    createDb: () => client,
    createRedis: () => redis,
    createTelemetry: () => recordingTelemetry().telemetry,
    entriesFor: (_cron, deps) => [
      {
        name: 'wake-probe',
        run: () =>
          runSettlement(deps.db, async (tx) => {
            collectJobWake(tx, 'bulk');
            await tx.execute(sql`select 1 as one`);
            if (outcome === 'abort') throw new Error('cron transaction aborted');
          }),
      },
    ],
  };
}

async function runWakeProbePass(outcome: 'commit' | 'abort'): Promise<string[]> {
  const dispatcher = recordingDispatcher();
  const client = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });
  await createScheduledHandler(wakeProbeRuntime(client, outcome))(
    { cron: JOBS_HEALTH_CRON },
    { NODE_ENV: 'development', JOB_DISPATCHER: dispatcher.namespace },
    { waitUntil: () => {} }
  );
  return dispatcher.woken;
}

describe('the cron-scoped wake capability', () => {
  it('nudges the dispatcher for a shard collected in a committed cron transaction', async () => {
    expect(await runWakeProbePass('commit')).toEqual(['bulk']);
  });

  it('nudges nothing when the cron transaction rolls back', async () => {
    expect(await runWakeProbePass('abort')).toEqual([]);
  });
});
