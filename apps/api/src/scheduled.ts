import { match } from 'ts-pattern';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { CRON_SCHEDULES, cronScheduleNameFor } from './composition/cron-schedules.js';
import { FINGERPRINT_CODES, createRequestTelemetry } from './lib/telemetry/index.js';
import {
  OPENROUTER_BASE_URL,
  createCatalogRefreshEntry,
  createCatalogSightingRecorder,
  productionRefreshJitter,
} from './slices/models/index.js';
import {
  createBillingAuditProbes,
  createCatalogModelMetaResolver,
  createLedgerConservationEntry,
  createPaymentsStatusAuditEntry,
  createPublicStatsSnapshotEntry,
  createPublicStatsStores,
  createSnapshotDriftEntry,
} from './slices/billing/index.js';
import {
  createAccessLogAuditEntry,
  createAccessLogReaderFromEnv,
  createAdminAuditDigestReads,
  createAdminDigestEnqueueEntry,
  createAdminDigestJobRegistration,
} from './slices/admin/index.js';
import {
  createBackupAuditEntry,
  createBackupRepositoryReaderFromEnv,
  createBackupRetentionAuditEntry,
  createMediaGcEntry,
  productionMediaGcDeps,
} from './slices/media/index.js';
import {
  createGrowthRollupEnqueueEntry,
  createGrowthRollupJobRegistration,
} from './slices/growth/index.js';
import {
  parseAdminNotificationRecipients,
  requireAdminUrl,
} from './composition/email/admin-op-notification-email.js';
import {
  adminAdmittedActors,
  parseAdminActorAllowlist,
  parseAdminRoleMap,
} from './lib/context/index.js';
import { createEmailSenderFromEnv, purgeStaleDeviceTokens } from './slices/notifications/index.js';
import { purgeUnconfirmedSubscribers } from './slices/newsletter/index.js';
import {
  purgeExpiredAccountDeletionEvents,
  purgeExpiredVerificationTokens,
} from './slices/identity/index.js';
import { createIdempotencyKeyPurgeEntry } from './lib/idempotency/index.js';
import {
  configureRateLimitBound,
  configureRateLimitKeySecret,
  rateLimitBound,
} from './lib/rate-limit/index.js';
import { createBoundedRedis } from './lib/resilience/index.js';
import {
  createAppJobRegistry,
  createDiscardedJobsPruneEntry,
  createDispatcherWake,
  createJobLeaseTimeoutEntry,
  createJobWakeCollector,
  createJobsHealthEntry,
  createJobsHealthProbes,
  createLeaseTimeoutProbes,
  createRetentionEntry,
  createSucceededJobsPruneEntry,
  dischargeJobWakes,
  enqueueOnlyDeps,
  grantJobWakes,
  runCronEntries,
} from './lib/jobs/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { RefreshJitter } from './slices/models/index.js';
import type { Bindings } from './lib/context/index.js';
import type { CronEntry, JobWakeCapable } from './lib/jobs/index.js';
import type { ScheduleCheckIn } from './lib/telemetry/check-in.js';
import type { Telemetry } from './lib/telemetry/index.js';

/**
 * The production cron surface: pollers, retention deletes, and read-only
 * auditors, plus the enqueues that hand scheduled delivery to the jobs system
 * — delivery itself never runs here (the jobs system owns it).
 * Each schedule constant mirrors one wrangler `[triggers]` cron expression
 * (asserted by test); same-cadence entries share one trigger and run
 * isolated, so one failing entry never stops its siblings.
 *
 * Deferred until its external API client exists: the aggregate-metrics
 * auditor (no metrics sink today — Sentry carries defects, and nothing
 * aggregates the Telemetry port's log lines).
 */

/**
 * One name apiece for the four entries of {@link CRON_SCHEDULES}, which
 * declares the expressions. Each is a reference to the map, so a schedule
 * renamed or re-timed there moves here with it and the two cannot disagree.
 */
export const JOBS_HEALTH_CRON = CRON_SCHEDULES['jobs-health'];
export const ACCESS_LOG_CRON = CRON_SCHEDULES['access-log'];
export const HOURLY_MAINTENANCE_CRON = CRON_SCHEDULES.hourly;
export const DAILY_RETENTION_CRON = CRON_SCHEDULES['daily-retention'];

/** The cron isolate reads the same bindings every other context does. */
export type ScheduledBindings = Bindings;

/** The structural slice of `ExecutionContext` the cron path needs. */
export interface CronContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CronDependencies {
  readonly env: ScheduledBindings;
  /**
   * The pass-scoped pool, carrying the job-wake capability the handler
   * granted: an entry's opener merges whatever its transaction collected back
   * onto this handle on commit, and the handler discharges the result before
   * it closes the pool.
   */
  readonly db: JobWakeCapable<Database>;
  readonly redis: Redis;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
  readonly isCI: boolean;
  /** Catalog-poller seams: tests replay the gateway; production binds live fetch. */
  readonly catalogFetch: typeof globalThis.fetch;
  readonly gatewayBaseUrl: string;
  readonly refreshJitter: RefreshJitter;
}

/**
 * The entries one trigger runs, or nothing for an expression no schedule
 * registers. Dispatch goes through the schedule's NAME rather than its
 * expression, which is what makes the two sets one: an expression outside
 * {@link CRON_SCHEDULES} reaches no branch, and a name inside it that has no
 * branch fails to compile at `.exhaustive()`.
 */
export function cronEntriesFor(cron: string, deps: CronDependencies): CronEntry[] | undefined {
  const schedule = cronScheduleNameFor(cron);
  if (schedule === undefined) return undefined;
  return match(schedule)
    .with('jobs-health', () => [
      createJobsHealthEntry({
        probes: createJobsHealthProbes(deps.db),
        telemetry: deps.telemetry,
        wake: createDispatcherWake(deps.env),
      }),
      createJobLeaseTimeoutEntry({
        probes: createLeaseTimeoutProbes(deps.db),
        telemetry: deps.telemetry,
      }),
    ])
    .with('hourly', () => {
      const billingProbes = createBillingAuditProbes(deps.db, deps.redis, deps.now);
      const { isProduction } = createEnvUtilities(deps.env);
      return [
        createCatalogRefreshEntry({
          db: deps.db,
          fetch: deps.catalogFetch,
          gatewayBaseUrl: deps.gatewayBaseUrl,
          telemetry: deps.telemetry,
          now: deps.now,
          recordSighting: createCatalogSightingRecorder(deps.db),
          // The start delay spreads a production fleet's triggers across the
          // provider's catalog; one local Worker is no fleet, so outside
          // production it is pure waiting ahead of every refresh.
          ...(isProduction ? { jitter: deps.refreshJitter } : {}),
          // Production keeps the 6-connection cap; dev refreshes fan out wider.
          endpointConcurrency: isProduction ? 6 : 30,
        }),
        createMediaGcEntry(() =>
          // Thread the flush-capable cron telemetry (createTelemetry binds
          // scheduleFlush to ctx.waitUntil) so a captured GC delete failure is
          // actually flushed to Sentry before the cron isolate freezes; the env
          // fallback in productionMediaGcDeps has no scheduleFlush and would drop it.
          productionMediaGcDeps({
            env: deps.env,
            db: deps.db,
            now: deps.now,
            isCI: deps.isCI,
            telemetry: deps.telemetry,
          })
        ),
        createLedgerConservationEntry({ audit: billingProbes.audit, telemetry: deps.telemetry }),
        createSnapshotDriftEntry({
          listWalletIds: billingProbes.listWalletIds,
          compare: billingProbes.compare,
          telemetry: deps.telemetry,
        }),
        createPaymentsStatusAuditEntry({
          audit: billingProbes.auditPaymentsStatus,
          telemetry: deps.telemetry,
        }),
        // Hourly is the fastest cadence this may sit on and the slowest one its
        // tolerance survives: the auditor allows three hours of silence, so a
        // six-hourly or daily slot would leave a stopped backup unreported for
        // longer than the tolerance it exists to enforce.
        createBackupAuditEntry(() => ({
          reader: createBackupRepositoryReaderFromEnv(deps.env, deps.now),
          telemetry: deps.telemetry,
          now: deps.now,
        })),
        // Cron enqueues; the dispatcher reduces. The window is the trailing set
        // of hours the counting store still holds rather than the previous hour
        // alone, so a missed tick is a hole the next one fills instead of a
        // permanent gap nothing pages on.
        createGrowthRollupEnqueueEntry({
          db: deps.db,
          resolveRegistry: () =>
            createAppJobRegistry([
              createGrowthRollupJobRegistration({
                db: deps.db,
                // Built with the registry, inside the run: the enqueue reads a
                // registration's schema, lease and shard and never its handler,
                // so this counter client is never opened here.
                resolveRedis: enqueueOnlyDeps(deps.redis),
                resolveTelemetry: () => deps.telemetry,
                now: deps.now,
              }),
            ]),
          now: deps.now,
        }),
      ];
    })
    .with('daily-retention', () => [
      createIdempotencyKeyPurgeEntry(deps.db),
      createSucceededJobsPruneEntry(deps.db),
      createDiscardedJobsPruneEntry(deps.db),
      // Slice-owned deletes reach cron by one route: the slice that is the
      // single writer of the table publishes the delete on its barrel, and
      // the binding to a retention entry happens here. A delete whose table
      // a `lib/` module owns publishes its cron entry directly instead, so
      // there is nothing to bind.
      createRetentionEntry('account-deletion-events-purge', (batchSize) =>
        purgeExpiredAccountDeletionEvents(deps.db, { batchSize })
      ),
      createRetentionEntry('expired-verification-token-purge', (batchSize) =>
        purgeExpiredVerificationTokens(deps.db, { batchSize })
      ),
      createRetentionEntry('stale-device-token-purge', (batchSize) =>
        purgeStaleDeviceTokens(deps.db, { batchSize })
      ),
      createRetentionEntry('unconfirmed-newsletter-subscriber-purge', (batchSize) =>
        purgeUnconfirmedSubscribers(deps.db, { batchSize })
      ),
      // Cron enqueues; the dispatcher delivers. Its own registry is
      // enqueue-only — `enqueueWithinTx` reads the registered
      // schema/lease/shard and never the handler, which runs in the
      // dispatcher DO against `createDispatcherJobRegistry`.
      createAdminDigestEnqueueEntry({
        db: deps.db,
        resolveRegistry: () =>
          createAppJobRegistry([
            createAdminDigestJobRegistration({
              auditReads: createAdminAuditDigestReads(deps.db),
              // Built with the registry, inside the run: an email-config
              // fault fails this entry's enqueue rather than the whole daily
              // set at construction — or a row that can never succeed.
              resolveSend: enqueueOnlyDeps({
                sender: createEmailSenderFromEnv(deps.env),
                adminEmails: parseAdminNotificationRecipients(deps.env.ADMIN_ROLE_MAP),
                adminUrl: requireAdminUrl(deps.env),
              }),
            }),
          ]),
        now: deps.now,
      }),
      createPublicStatsSnapshotEntry({
        db: deps.db,
        stores: createPublicStatsStores(),
        now: deps.now,
        resolveModelMeta: createCatalogModelMetaResolver({
          db: deps.db,
          telemetry: deps.telemetry,
        }),
      }),
      // Daily rather than hourly: a clean repository costs a full paged
      // listing every run while a violation stops at the first offender, and
      // what it detects moves on a scale of days — so an hourly cadence would
      // spend twenty-four times the listing budget to learn the same fact.
      createBackupRetentionAuditEntry(() => ({
        reader: createBackupRepositoryReaderFromEnv(deps.env, deps.now),
        telemetry: deps.telemetry,
        now: deps.now,
      })),
    ])
    .with('access-log', () => [
      createAccessLogAuditEntry({
        resolveReader: () => createAccessLogReaderFromEnv(deps.env),
        // The expected-actor set is what the two wall bindings admit TOGETHER,
        // not the operator subset and not either binding alone: this auditor
        // alerts on an authentication the in-Worker wall would have refused,
        // so its set must be exactly the set that wall admits. Who HEARS about
        // such an authentication is a different question, and that recipient
        // list is the operator subset.
        admittedActors: () =>
          adminAdmittedActors(
            parseAdminActorAllowlist(deps.env.ADMIN_ACTOR_ALLOWLIST),
            parseAdminRoleMap(deps.env.ADMIN_ROLE_MAP)
          ),
        telemetry: deps.telemetry,
        now: deps.now,
      }),
    ])
    .exhaustive();
}

/** The infra seams the handler needs; tests fake them, production binds live clients. */
export interface ScheduledRuntime {
  createDb(env: ScheduledBindings): Database;
  createRedis(env: ScheduledBindings): Redis;
  createTelemetry(env: ScheduledBindings, ctx: CronContext): Telemetry & ScheduleCheckIn;
  entriesFor(cron: string, deps: CronDependencies): CronEntry[] | undefined;
}

export function createScheduledHandler(
  runtime: ScheduledRuntime
): (controller: { cron: string }, env: ScheduledBindings, ctx: CronContext) => Promise<void> {
  return async (controller, env, ctx): Promise<void> => {
    const telemetry = runtime.createTelemetry(env, ctx);
    const { isCI } = createEnvUtilities(env);
    // Mint and discharge in one scope: a second grant on the same handle
    // would replace this collector rather than merge into it, so the two
    // halves stay together where nothing can come between them.
    const jobWakes = createJobWakeCollector();
    const db = grantJobWakes(runtime.createDb(env), jobWakes);
    try {
      const entries = runtime.entriesFor(controller.cron, {
        env,
        db,
        redis: runtime.createRedis(env),
        telemetry,
        now: () => new Date(),
        isCI,
        catalogFetch: globalThis.fetch.bind(globalThis),
        gatewayBaseUrl: OPENROUTER_BASE_URL,
        refreshJitter: productionRefreshJitter(),
      });
      if (entries === undefined) {
        telemetry.error('scheduled trigger fired with an unregistered cron expression', {
          errorCode: 'cron_unknown_schedule',
        });
        telemetry.captureError(
          new Error('scheduled trigger fired with an unregistered cron expression'),
          FINGERPRINT_CODES.cronUnknownSchedule
        );
        return;
      }
      // The four schedules share one trigger mechanism, so the most frequent
      // one brackets its pass and its monitor reports the whole isolate's absence.
      const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
      if (checksIn) {
        telemetry.checkIn('in_progress');
      }
      await runCronEntries(entries, telemetry);
      if (checksIn) {
        telemetry.checkIn('ok');
      }
    } finally {
      // After every committing transaction the pass opened, before the
      // connection it used is gone. Lossy by design: a wake that fails changes
      // nothing, because the dispatcher's alarm is the delivery guarantee.
      await dischargeJobWakes(env, jobWakes);
      // The cron path opens its own connection (no request context), so it
      // also closes it — an idle Worker holds no sockets between triggers.
      await db.$client.end();
    }
  };
}

export const productionScheduledRuntime: ScheduledRuntime = {
  createDb(env: ScheduledBindings): Database {
    const databaseUrl = env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'scheduled handler: missing required binding DATABASE_URL — the cron fails fast instead of degrading.'
      );
    }
    const { isDev } = createEnvUtilities(env);
    return isDev
      ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
      : createDb(databaseUrl);
  },
  createRedis(env: ScheduledBindings): Redis {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (url === undefined || url === '' || token === undefined || token === '') {
      throw new Error(
        'scheduled handler: missing required bindings UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — the cron fails fast instead of degrading.'
      );
    }
    // The cron isolate has no request pipeline, so the bound on one round trip
    // to this store is put in force here, from this env's registry entry, and
    // read back for the client that runs under it. Both readers need it: the
    // client bounds every command, and a counter check a cron entry reaches
    // would otherwise throw instead of counting. The identifier key is put in
    // force beside it, for the same counter check.
    configureRateLimitBound(env);
    configureRateLimitKeySecret(env);
    return createBoundedRedis({ url, token }, rateLimitBound().timeoutMs);
  },
  createTelemetry(env: ScheduledBindings, ctx: CronContext): Telemetry & ScheduleCheckIn {
    return createRequestTelemetry(env, {
      scheduleFlush: ctx.waitUntil.bind(ctx),
      monitorCrontab: JOBS_HEALTH_CRON,
    });
  },
  entriesFor: cronEntriesFor,
};

export const scheduledHandler = createScheduledHandler(productionScheduledRuntime);
