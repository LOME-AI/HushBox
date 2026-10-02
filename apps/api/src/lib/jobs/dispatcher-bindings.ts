import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { FINGERPRINT_CODES, createDurableObjectTelemetry } from '../telemetry/index.js';
import { createJobExecutor } from './pass.js';
import { createJobRegistry } from './registry.js';
import { createJobWakeCollector, dischargeJobWakes, grantJobWakes } from './wake-capability.js';
import type { Database } from '@hushbox/db';
import type { DispatcherTelemetry, JobDispatcherBindings } from '@hushbox/realtime';
import type { Bindings } from '../context/app-env.js';
import type { DurableObjectTelemetryOptions, Telemetry } from '../telemetry/index.js';
import type { JobRegistration, JobRegistry } from './registry.js';
import type { JobWakeCapable } from './wake-capability.js';

/**
 * The worker-side dependency set for the JobDispatcher DO. Everything here
 * is plain and node-testable; the composition module (dispatcher-binding.ts)
 * is the only file that touches the platform class factory.
 */

/**
 * Wall budget for one pass's drain chaining — far inside the platform's
 * 15-minute alarm cap so a busy shard re-fires instead of hitting the wall.
 */
const JOB_DISPATCHER_PASS_BUDGET_MS = 60_000;

/**
 * The product registry: the composition root passes the job registrations its
 * owning slices publish (e.g. billing's `payment.verify.v1`), so this module
 * stays free of any slice import — a slice-dependent registration cannot be
 * built here (lib may not import a slice), it is constructed at the composition
 * seam and handed in. An empty default keeps callers that have no registrations
 * yet (the platform-loaded dispatcher DO binding, which lives in lib and so
 * cannot build a slice's registration either) compiling unchanged.
 */
export function createAppJobRegistry(registrations: readonly JobRegistration[] = []): JobRegistry {
  const registry = createJobRegistry();
  for (const registration of registrations) {
    registry.register(registration);
  }
  return registry;
}

/** Maps the dispatcher's closed telemetry event set onto the typed port. */
export function createDispatcherTelemetry(telemetry: Telemetry): DispatcherTelemetry {
  return {
    passFailed: ({ shard }) => {
      telemetry.error('job dispatcher pass failed');
      // The shard name is infrastructure vocabulary (default|bulk), never
      // content — safe inside the captured error's message.
      telemetry.captureError(
        new Error(`job dispatcher pass failed on shard ${shard}`),
        FINGERPRINT_CODES.jobPassFailed
      );
    },
  };
}

export function openDispatcherDb(
  databaseUrl: string,
  envUtilities: { readonly isDev: boolean }
): Database {
  return envUtilities.isDev
    ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
    : createDb(databaseUrl);
}

/**
 * One pass's database scope: a fresh Neon connection carrying the job-wake
 * capability, so an opener merges whatever its transaction collected back onto
 * this handle on commit. Mint and discharge sit in one scope — a second grant
 * on the same handle would replace this collector rather than merge into it —
 * and the wakes fire after the last committing transaction, before the
 * connection they were collected on is closed. Lossy by design: a wake that
 * fails changes nothing, because the dispatcher's alarm is the delivery
 * guarantee.
 */
export function createDispatcherDbScope(
  env: Bindings,
  databaseUrl: string
): <T>(use: (db: JobWakeCapable<Database>) => Promise<T>) => Promise<T> {
  const envUtilities = createEnvUtilities(env);
  return async <T>(use: (db: JobWakeCapable<Database>) => Promise<T>): Promise<T> => {
    const jobWakes = createJobWakeCollector();
    const db = grantJobWakes(openDispatcherDb(databaseUrl, envUtilities), jobWakes);
    try {
      return await use(db);
    } finally {
      await dischargeJobWakes(env, jobWakes);
      await db.$client.end();
    }
  };
}

export function createJobDispatcherBindings(
  env: Bindings,
  registry: JobRegistry,
  telemetryOptions: DurableObjectTelemetryOptions = {}
): JobDispatcherBindings {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'JobDispatcher: missing required binding DATABASE_URL. ' +
        'Set it in wrangler config / .dev.vars — the dispatcher fails fast instead of degrading.'
    );
  }
  const telemetry = createDurableObjectTelemetry(env, telemetryOptions);
  const executor = createJobExecutor({
    // Fresh Neon connection per invocation; closed when the pass ends so an
    // idle dispatcher holds no sockets across its decaying alarms.
    withDb: createDispatcherDbScope(env, databaseUrl),
    registry,
    telemetry,
    claimantId: crypto.randomUUID(),
    random: Math.random,
    now: () => Date.now(),
    passBudgetMs: JOB_DISPATCHER_PASS_BUDGET_MS,
  });
  return {
    executor,
    telemetry: createDispatcherTelemetry(telemetry),
    now: () => Date.now(),
  };
}
