import type { Bindings, RequiredBindings } from '../lib/context/index.js';

/**
 * Every binding a request through the assembled pipeline needs, typed
 * REQUIRED. `Bindings` types each entry optional, so an incomplete record is
 * assignable to it and the omission surfaces only as a stage's throw — a 500
 * on assertions about something else entirely. Naming the keys here makes an
 * incomplete record a compile error on this file instead.
 *
 * `RequiredBindings` is the set `assertRequiredBindings` gates, so a key added
 * there arrives here as a compile error. The ones picked beside it are the
 * stages that own their own fail-fast and are deliberately outside that gate:
 * the mode `createEnvUtilities` reads, the sink list `createRequestTelemetry`
 * demands, and the counter's Redis bound and identifier key, which
 * `configureRateLimitBound` and `configureRateLimitKeySecret` refuse to
 * default.
 */
type WorkersPipelineBindings = RequiredBindings &
  Required<
    Pick<
      Bindings,
      'NODE_ENV' | 'TELEMETRY_SINKS' | 'RATE_LIMIT_REDIS_TIMEOUT_MS' | 'RATE_LIMIT_KEY_SECRET'
    >
  >;

/**
 * The bindings record a workers-project test hands `app.request`, shared so
 * that a test about one stage cannot fail on a binding a different stage
 * wanted. It is the Worker's own per-request record: a `[vars]` entry in
 * `apps/api/wrangler.toml` and a deployed secret both arrive as keys of the
 * single `env` workerd hands the Worker, and `app.request`'s third argument is
 * that record. The values are placeholders — nothing here reaches a live
 * Postgres or Redis — and the mode is this record's own `NODE_ENV`; which
 * number each mode carries for the Redis bound is the
 * `RATE_LIMIT_REDIS_TIMEOUT_MS` entry in `packages/shared/src/env/env.config.ts`.
 */
export const WORKERS_PIPELINE_BINDINGS = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
  RATE_LIMIT_KEY_SECRET: 'workers-rate-limit-key',
} as const satisfies WorkersPipelineBindings;
