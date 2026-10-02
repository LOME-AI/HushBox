import { Redis } from '@upstash/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
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
import { ADMIN_DIGEST_JOB_TYPE } from '../slices/admin/index.js';
import {
  DAILY_RETENTION_CRON,
  createScheduledHandler,
  HOURLY_MAINTENANCE_CRON,
  JOBS_HEALTH_CRON,
  cronEntriesFor,
  scheduledHandler,
} from '../scheduled.js';
import type { Database } from '@hushbox/db';
import type { JobDispatcherNamespace } from '../lib/jobs/index.js';
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

const db = grantJobWakes(
  createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const redis = new Redis({
  url: requireEnv('UPSTASH_REDIS_REST_URL'),
  token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
});

interface TelemetryRecorder {
  readonly telemetry: Telemetry & ScheduleCheckIn;
  readonly captured: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const captured: string[] = [];
  const telemetry: Telemetry & ScheduleCheckIn = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (_msg: string, _fields?: SafeLogFields) => {},
    captureError: (_error, code: string) => {
      captured.push(code);
    },
    checkIn: () => {},
  };
  return { telemetry, captured };
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
    try {
      const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, liveDeps(recorder.telemetry));
      if (entries === undefined) throw new Error('hourly cron mapped no entries');
      await runCronEntries(entries, recorder.telemetry);
    } finally {
      await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
    }
    // Ambient dev data may legitimately page an auditor; what must never
    // appear is an entry-level failure.
    expect(recorder.captured).not.toContain('cron_entry_failed');
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
    await runCronEntries(entries, recorder.telemetry);
    expect(recorder.captured).not.toContain('cron_entry_failed');
    expect(await clearDigestRows()).toBeGreaterThanOrEqual(1);
  });
});

describe('the jobs-health pass', () => {
  it('probes the live jobs table without an entry failure', async () => {
    const recorder = recordingTelemetry();
    const entries = cronEntriesFor(JOBS_HEALTH_CRON, liveDeps(recorder.telemetry));
    if (entries === undefined) throw new Error('jobs-health cron mapped no entries');
    await runCronEntries(entries, recorder.telemetry);
    expect(recorder.captured).not.toContain('cron_entry_failed');
  });
});

describe('scheduledHandler (production runtime, end to end)', () => {
  it('executes a daily retention trigger against the live stack', async () => {
    const env = { ...process.env, TELEMETRY_SINKS: 'console' } as ScheduledBindings;
    await expect(
      scheduledHandler({ cron: DAILY_RETENTION_CRON }, env, { waitUntil: () => {} })
    ).resolves.toBeUndefined();
    expect(await clearDigestRows()).toBeGreaterThanOrEqual(1);
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
