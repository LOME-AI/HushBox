import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  ACCESS_LOG_CRON,
  DAILY_RETENTION_CRON,
  HOURLY_MAINTENANCE_CRON,
  JOBS_HEALTH_CRON,
  createScheduledHandler,
  cronEntriesFor,
  productionScheduledRuntime,
} from '../scheduled.js';
import { rateLimitBound } from '../lib/rate-limit/index.js';
import { createJobWakeCollector, grantJobWakes } from '../lib/jobs/index.js';
import type { Database } from '@hushbox/db';
import type { CronEntry } from '../lib/jobs/index.js';
import type { ScheduleCheckIn } from '../lib/telemetry/check-in.js';
import type { SafeLogFields, Telemetry } from '../lib/telemetry/index.js';
import type { CronDependencies, ScheduledBindings, ScheduledRuntime } from '../scheduled.js';

interface TelemetryRecorder {
  readonly telemetry: Telemetry & ScheduleCheckIn;
  readonly errors: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captured: string[];
  /** Check-in statuses and entry runs in the order the pass produced them. */
  readonly passEvents: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const errors: TelemetryRecorder['errors'] = [];
  const captured: string[] = [];
  const passEvents: string[] = [];
  const telemetry: Telemetry & ScheduleCheckIn = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    captureError: (_error, code: string) => {
      captured.push(code);
    },
    checkIn: (status: 'in_progress' | 'ok') => {
      passEvents.push(status);
    },
  };
  return { telemetry, errors, captured, passEvents };
}

function fakeDeps(): CronDependencies {
  return {
    env: { NODE_ENV: 'development' } as ScheduledBindings,
    db: grantJobWakes({} as Database, createJobWakeCollector()),
    redis: {} as Redis,
    telemetry: recordingTelemetry().telemetry,
    now: () => new Date(),
    isCI: false,
    catalogFetch: () => Promise.reject(new Error('unused')),
    gatewayBaseUrl: 'https://gateway.test/api/v1',
    refreshJitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
  };
}

/**
 * The hourly poller entry under one NODE_ENV, wired to a gateway that refuses
 * so the run ends at the fetch: a recorded sleep can then only be the start
 * jitter, never any of the refresh's own work.
 */
function catalogRefreshEntryFor(nodeEnv: string, sleeps: number[]): CronEntry {
  const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, {
    ...fakeDeps(),
    env: { NODE_ENV: nodeEnv } as ScheduledBindings,
    catalogFetch: () => Promise.reject(new Error('gateway unreachable')),
    refreshJitter: {
      maxMs: 60_000,
      random: () => 0.5,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  });
  const entry = entries?.find((candidate) => candidate.name === 'model-catalog-refresh');
  if (entry === undefined) throw new Error('hourly entries carry no catalog refresh');
  return entry;
}

/**
 * The access-log entry against a stubbed Cloudflare API. Production is the
 * only mode that binds the real reader, and the reader is the only way to put
 * an authentication in front of the auditor's expected-actor set — the fake
 * every other mode binds reports no events at all. Both wall bindings are
 * given, because the expected set is what they admit together.
 */
function accessLogEntryFor(
  bindings: { allowlist: string; roleMap: string },
  authenticatedEmail: string
): { run: () => Promise<void>; captured: string[] } {
  const recorder = recordingTelemetry();
  const entries = cronEntriesFor(ACCESS_LOG_CRON, {
    ...fakeDeps(),
    env: {
      NODE_ENV: 'production',
      CLOUDFLARE_ACCESS_LOG_API_TOKEN: 'access-log-token',
      CLOUDFLARE_ACCOUNT_ID: 'access-log-account',
      ADMIN_ACTOR_ALLOWLIST: bindings.allowlist,
      ADMIN_ROLE_MAP: bindings.roleMap,
    } as ScheduledBindings,
    telemetry: recorder.telemetry,
  });
  const entry = entries?.find((candidate) => candidate.name === 'admin-access-log-audit');
  if (entry === undefined) throw new Error('access-log audit entry missing');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    const result =
      new URL(url).searchParams.get('page') === '1'
        ? [
            {
              user_email: authenticatedEmail,
              action: 'login',
              created_at: isoAt(TEST_DAY_START + 11 * 60 * 60 * 1000),
            },
          ]
        : [];
    return Promise.resolve(Response.json({ success: true, result }));
  });
  return { run: entry.run, captured: recorder.captured };
}

describe('cron schedule constants', () => {
  it('mirror the wrangler [triggers] crons exactly', () => {
    const wranglerToml = readFileSync(
      fileURLToPath(new URL('../../wrangler.toml', import.meta.url)),
      'utf8'
    );
    const cronsLine = /crons\s*=\s*\[(?<list>[^\]]*)\]/.exec(wranglerToml)?.groups?.['list'];
    if (cronsLine === undefined) throw new Error('wrangler.toml has no [triggers] crons list');
    const deployed = [...cronsLine.matchAll(/"(?<expr>[^"]+)"/g)].map(
      (match) => match.groups?.['expr']
    );
    expect(deployed).toEqual([
      JOBS_HEALTH_CRON,
      ACCESS_LOG_CRON,
      HOURLY_MAINTENANCE_CRON,
      DAILY_RETENTION_CRON,
    ]);
  });
});

describe('cronEntriesFor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes the fifteen-minute schedule to both jobs auditors', () => {
    const entries = cronEntriesFor(JOBS_HEALTH_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual([
      'jobs-health-audit',
      'job-lease-timeout-audit',
    ]);
  });

  it('routes the hourly schedule to the pollers and auditors', () => {
    const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual([
      'model-catalog-refresh',
      'media-gc',
      'ledger-conservation-audit',
      'wallet-snapshot-drift-audit',
      'payments-status-audit',
      'backup-repository-audit',
      'growth-rollup-enqueue',
    ]);
  });

  it('routes the daily schedule to the retention deletes and the admin digest', () => {
    const entries = cronEntriesFor(DAILY_RETENTION_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual([
      'idempotency-key-purge',
      'jobs-succeeded-prune',
      'jobs-discarded-prune',
      'account-deletion-events-purge',
      'expired-verification-token-purge',
      'stale-device-token-purge',
      'unconfirmed-newsletter-subscriber-purge',
      'admin-daily-digest-enqueue',
      'public-stats-snapshot',
      'backup-retention-audit',
    ]);
  });

  it('routes the six-hour schedule to the access-log auditor', () => {
    const entries = cronEntriesFor(ACCESS_LOG_CRON, fakeDeps());
    expect(entries?.map((entry) => entry.name)).toEqual(['admin-access-log-audit']);
  });

  it('runs the access-log audit entry, resolving its reader and allowlist (dev fake reader)', async () => {
    const entries = cronEntriesFor(ACCESS_LOG_CRON, {
      ...fakeDeps(),
      env: {
        NODE_ENV: 'development',
        ADMIN_ACTOR_ALLOWLIST: 'admin@hushbox.ai',
        ADMIN_ROLE_MAP: 'admin@hushbox.ai=operator',
      } as ScheduledBindings,
    });
    const entry = entries?.find((candidate) => candidate.name === 'admin-access-log-audit');
    if (entry === undefined) throw new Error('access-log audit entry missing');
    // Dev resolves a fake, empty reader — the run drives the resolveReader and
    // allowlist thunks and completes without emitting an alert.
    await expect(entry.run()).resolves.toBeUndefined();
  });

  it('leaves a viewer authentication unalerted — both bindings admit a viewer', async () => {
    const audit = accessLogEntryFor(
      {
        allowlist: 'admin@hushbox.test,viewer@hushbox.test',
        roleMap: 'admin@hushbox.test=operator,viewer@hushbox.test=growth-viewer',
      },
      'viewer@hushbox.test'
    );
    await audit.run();
    expect(audit.captured).toEqual([]);
  });

  it('alerts on an authentication by an email the role map has no entry for', async () => {
    const audit = accessLogEntryFor(
      {
        allowlist: 'admin@hushbox.test,stranger@example.com',
        roleMap: 'admin@hushbox.test=operator',
      },
      'stranger@example.com'
    );
    await audit.run();
    expect(audit.captured).toEqual(['admin_access_unexpected_actor']);
  });

  it('alerts on an authentication by an email the actor allowlist omits', async () => {
    const audit = accessLogEntryFor(
      {
        allowlist: 'admin@hushbox.test',
        roleMap: 'admin@hushbox.test=operator,viewer@hushbox.test=growth-viewer',
      },
      'viewer@hushbox.test'
    );
    await audit.run();
    expect(audit.captured).toEqual(['admin_access_unexpected_actor']);
  });

  it('confines an email-configuration fault to the digest enqueue entry', async () => {
    // The digest's send deps are built where the enqueue happens — inside the
    // entry's own run, so the fault is one entry's failure rather than the
    // whole daily set's, and so a misconfigured deploy fails the enqueue
    // instead of writing a row that can never succeed.
    const entries = cronEntriesFor(DAILY_RETENTION_CRON, {
      ...fakeDeps(),
      env: {} as ScheduledBindings,
    });
    const entry = entries?.find((candidate) => candidate.name === 'admin-daily-digest-enqueue');
    if (entry === undefined) throw new Error('digest enqueue entry missing');

    const healthy = cronEntriesFor(DAILY_RETENTION_CRON, fakeDeps());
    expect(entries?.map((candidate) => candidate.name)).toEqual(
      healthy?.map((candidate) => candidate.name)
    );
    await expect(entry.run()).rejects.toThrow('NODE_ENV must be set explicitly');
  });

  it('routes the hourly schedule in production too (the 6-connection catalog cap)', () => {
    const entries = cronEntriesFor(HOURLY_MAINTENANCE_CRON, {
      ...fakeDeps(),
      env: { NODE_ENV: 'production' } as ScheduledBindings,
    });
    expect(entries?.map((entry) => entry.name)).toEqual([
      'model-catalog-refresh',
      'media-gc',
      'ledger-conservation-audit',
      'wallet-snapshot-drift-audit',
      'payments-status-audit',
      'backup-repository-audit',
      'growth-rollup-enqueue',
    ]);
  });

  it('starts the hourly catalog refresh with no delay outside production', async () => {
    const sleeps: number[] = [];
    await expect(catalogRefreshEntryFor('development', sleeps).run()).rejects.toThrow(
      'unavailable'
    );
    expect(sleeps).toEqual([]);
  });

  it('keeps the catalog refresh start delay in production', async () => {
    const sleeps: number[] = [];
    await expect(catalogRefreshEntryFor('production', sleeps).run()).rejects.toThrow('unavailable');
    expect(sleeps).toEqual([30_000]);
  });

  it('returns undefined for an unregistered cron expression', () => {
    expect(cronEntriesFor('59 23 * * *', fakeDeps())).toBeUndefined();
  });
});

interface HandlerHarness {
  readonly runtime: ScheduledRuntime;
  readonly recorder: TelemetryRecorder;
  readonly dbEnds: number[];
}

function handlerHarness(entriesFor: ScheduledRuntime['entriesFor']): HandlerHarness {
  const recorder = recordingTelemetry();
  const dbEnds: number[] = [];
  const runtime: ScheduledRuntime = {
    createDb: () =>
      ({
        $client: {
          end: () => {
            dbEnds.push(1);
            return Promise.resolve();
          },
        },
      }) as unknown as Database,
    createRedis: () => ({}) as Redis,
    createTelemetry: () => recorder.telemetry,
    entriesFor,
  };
  return { runtime, recorder, dbEnds };
}

const ENV: ScheduledBindings = { NODE_ENV: 'development' } as ScheduledBindings;
const CTX = { waitUntil: () => {} };

describe('createScheduledHandler', () => {
  it('captures an unregistered cron expression and still closes the db', async () => {
    const harness = handlerHarness(cronEntriesFor);
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: 'bogus' }, ENV, CTX);
    expect(harness.recorder.captured).toEqual(['cron_unknown_schedule']);
    expect(harness.dbEnds).toHaveLength(1);
  });

  it('runs the matched entries and closes the db afterwards', async () => {
    const ran: string[] = [];
    const harness = handlerHarness(() => [
      {
        name: 'first',
        run: () => {
          ran.push('first');
          return Promise.resolve();
        },
      },
      {
        name: 'second',
        run: () => {
          ran.push('second');
          return Promise.resolve();
        },
      },
    ]);
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: JOBS_HEALTH_CRON }, ENV, CTX);
    expect(ran).toEqual(['first', 'second']);
    expect(harness.recorder.captured).toEqual([]);
    expect(harness.dbEnds).toHaveLength(1);
  });

  it('supplies live cron dependencies to the entry mapping', async () => {
    let seen: CronDependencies | undefined;
    const harness = handlerHarness((_cron, deps) => {
      seen = deps;
      return [];
    });
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: JOBS_HEALTH_CRON }, ENV, CTX);
    if (seen === undefined) throw new Error('entriesFor never received deps');
    expect(seen.now()).toBeInstanceOf(Date);
    expect(seen.gatewayBaseUrl).toContain('openrouter.ai');
    expect(seen.refreshJitter.maxMs).toBe(60_000);
  });

  it('brackets the jobs-health entries with the monitor check-in', async () => {
    const harness = handlerHarness(() => []);
    const runtime: ScheduledRuntime = {
      ...harness.runtime,
      entriesFor: () => [
        {
          name: 'probe',
          run: () => {
            harness.recorder.passEvents.push('entries-ran');
            return Promise.resolve();
          },
        },
      ],
    };

    await createScheduledHandler(runtime)({ cron: JOBS_HEALTH_CRON }, ENV, CTX);

    expect(harness.recorder.passEvents).toEqual(['in_progress', 'entries-ran', 'ok']);
  });

  it.each([ACCESS_LOG_CRON, HOURLY_MAINTENANCE_CRON, DAILY_RETENTION_CRON])(
    'leaves the pass on %s unchecked-in',
    async (cron) => {
      const harness = handlerHarness(() => []);

      await createScheduledHandler(harness.runtime)({ cron }, ENV, CTX);

      expect(harness.recorder.passEvents).toEqual([]);
    }
  );

  it('contains an entry failure and closes the db regardless', async () => {
    const harness = handlerHarness(() => [
      { name: 'broken', run: () => Promise.reject(new Error('boom')) },
    ]);
    const handler = createScheduledHandler(harness.runtime);
    await handler({ cron: HOURLY_MAINTENANCE_CRON }, ENV, CTX);
    expect(harness.recorder.captured).toEqual(['cron_entry_failed']);
    expect(harness.dbEnds).toHaveLength(1);
  });
});

describe('productionScheduledRuntime', () => {
  const DEV_ENV = {
    NODE_ENV: 'development',
    DATABASE_URL:
      process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hushbox',
    UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    TELEMETRY_SINKS: 'console',
  } as ScheduledBindings;

  it('fails fast on a missing DATABASE_URL', () => {
    expect(() =>
      productionScheduledRuntime.createDb({ NODE_ENV: 'development' } as ScheduledBindings)
    ).toThrow('DATABASE_URL');
  });

  it('opens (and can close) a dev-mode db handle', async () => {
    const db = productionScheduledRuntime.createDb(DEV_ENV);
    await expect(db.$client.end()).resolves.toBeUndefined();
  });

  it('opens (and can close) a production-mode db handle', async () => {
    const db = productionScheduledRuntime.createDb({
      ...DEV_ENV,
      NODE_ENV: 'production',
    } as ScheduledBindings);
    await expect(db.$client.end()).resolves.toBeUndefined();
  });

  it('fails fast on missing Redis bindings', () => {
    expect(() =>
      productionScheduledRuntime.createRedis({ NODE_ENV: 'development' } as ScheduledBindings)
    ).toThrow('UPSTASH');
  });

  it('builds a Redis client from the bindings', () => {
    expect(productionScheduledRuntime.createRedis(DEV_ENV)).toBeInstanceOf(Redis);
  });

  // The cron holds a Redis client, so a cron entry that ever reaches a counter
  // must find the bound already in force rather than an unbounded wait. Reading
  // the entry is what proves the wiring: an env whose value disagrees with the
  // one the process already settled can only be refused by a root that read it.
  it('puts the counter bound in force from its own bindings', () => {
    expect(() =>
      productionScheduledRuntime.createRedis({
        ...DEV_ENV,
        RATE_LIMIT_REDIS_TIMEOUT_MS: String(rateLimitBound().timeoutMs + 1),
      } as ScheduledBindings)
    ).toThrow('RATE_LIMIT_REDIS_TIMEOUT_MS');
  });

  it('puts the counter identifier key in force from its own bindings', () => {
    expect(() =>
      productionScheduledRuntime.createRedis({
        ...DEV_ENV,
        RATE_LIMIT_KEY_SECRET: `${String(process.env['RATE_LIMIT_KEY_SECRET'])}-disagreeing`,
      } as ScheduledBindings)
    ).toThrow('RATE_LIMIT_KEY_SECRET');
  });

  it('answers a failed round trip with a typed domain error, not the raw client error', async () => {
    // The store answers, and its answer is a failure. An unbounded client
    // throws its own `UpstashError`, which carries no taxonomy code; only a
    // client built through the policy factory translates it, so this is what
    // distinguishes the two without waiting out a deadline.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (): Promise<Response> =>
          Promise.resolve(Response.json({ error: 'store refused' }, { status: 500 }))
      )
    );
    try {
      await expect(
        productionScheduledRuntime.createRedis(DEV_ENV).get('key')
      ).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds the telemetry fan-out from the sink registry', () => {
    const telemetry = productionScheduledRuntime.createTelemetry(DEV_ENV, {
      waitUntil: () => {},
    });
    telemetry.info('cron telemetry smoke check');
    // A sink the registry names but the env cannot satisfy is refused, which is
    // what proves the list is read rather than a fixed console fan-out.
    expect(() =>
      productionScheduledRuntime.createTelemetry(
        { ...DEV_ENV, TELEMETRY_SINKS: 'sentry' } as ScheduledBindings,
        { waitUntil: () => {} }
      )
    ).toThrow('SENTRY_DSN');
  });

  it('routes entries through cronEntriesFor', () => {
    expect(productionScheduledRuntime.entriesFor).toBe(cronEntriesFor);
  });
});
