import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { EnvContext, EnvUtilities } from '@hushbox/shared';
import type { JobDispatcherNamespace, JobWakeCapable } from '../jobs/index.js';
import type { Telemetry } from '../telemetry/index.js';
import type { DependencyFailure } from './dependency-failure.js';
import type { Principal } from './principal.js';
import type { RouteClass } from './route-class.js';

/**
 * Worker bindings the app reads. All request-critical bindings are typed
 * optional because the runtime cannot guarantee them — `assertRequiredBindings`
 * is the single place that narrows them, failing fast per request. Extends
 * `EnvContext` so `createEnvUtilities(c.env)` is the only env-detection path.
 */
export interface Bindings extends EnvContext {
  DATABASE_URL?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  IRON_SESSION_SECRET?: string;
  // Identity-slice secrets: the key that seals each user's OPAQUE server
  // material, the key that seals stored TOTP secrets, and the seed for the
  // decoy records served to unknown identifiers. Consumed only by the identity
  // slice, which owns its own per-request fail-fast — deliberately NOT in
  // `assertRequiredBindings`, so surfaces that never touch OPAQUE (and their
  // test environments) don't have to carry them.
  OPAQUE_KEK?: string;
  TOTP_ENCRYPTION_SECRET?: string;
  ENUMERATION_DECOY_SECRET?: string;
  // OpenRouter inference key. Consumed only by the chat conversation runtime
  // (the DO's model provider), which owns its own fail-fast — deliberately NOT
  // in `assertRequiredBindings`, so surfaces that never run inference (and
  // their test environments) don't have to carry it.
  OPENROUTER_API_KEY?: string;
  // Admin-plane Access verification (team domain → JWKS/issuer, app AUD,
  // exact-match actor allowlist) plus the dev-only local signing key.
  // Consumed only by the admin JWT pipeline stage, which owns its own
  // fail-fast at the first admin-classed request — deliberately NOT in
  // `assertRequiredBindings`, so surfaces that never mount admin routes (and
  // their test environments) don't have to carry them.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  // The SQL panel's SELECT-only second connection (admin slice reads).
  // Consumed only by the admin read surface, which owns its own fail-fast —
  // deliberately NOT in `assertRequiredBindings`.
  ADMIN_SQL_PANEL_DATABASE_URL?: string;
  ADMIN_ACTOR_ALLOWLIST?: string;
  ADMIN_ROLE_MAP?: string;
  CF_ACCESS_DEV_PRIVATE_JWK?: string;
  // Telemetry composition vars. TELEMETRY_SINKS is the per-mode sink registry
  // value (every mode declares one; `createRequestTelemetry` fails fast when
  // it is missing); SENTRY_DSN is required only when that list names the
  // sentry sink. Neither is gated by `assertRequiredBindings` — the telemetry
  // composition owns its own fail-fast.
  TELEMETRY_SINKS?: string;
  SENTRY_DSN?: string;
  // How long one Redis round trip inside the rate-limit counter may take.
  // Per-mode registry data rather than a constant — the test environments
  // reach Redis through an emulating proxy under saturated parallelism, where
  // the production bound measures the proxy. Consumed by the bindings stage,
  // which owns its own fail-fast — deliberately NOT in
  // `assertRequiredBindings`, whose narrowed type every route already reads.
  RATE_LIMIT_REDIS_TIMEOUT_MS?: string;
  // The key every rate-limit identifier is HMACed under before it names a Redis
  // key. Read by every isolate entry that puts `RATE_LIMIT_REDIS_TIMEOUT_MS` in
  // force, which owns its own fail-fast for the same reason.
  RATE_LIMIT_KEY_SECRET?: string;
  // The key every idempotency body hash is HMACed under. Read by the bindings
  // stage, which owns its own fail-fast for the same reason.
  IDEMPOTENCY_BODY_HASH_SECRET?: string;
  // The key growth derives its per-day visitor hash and address identities
  // under. Read by the beacon route, which fails fast without it, and by
  // registration, which reports its absence and still signs the caller up —
  // deliberately NOT in `assertRequiredBindings`, so surfaces that never count
  // growth (and their test environments) don't have to carry it.
  GROWTH_HASH_SECRET?: string;
  // The JobDispatcher DO namespace, declared on the one Worker every context
  // here is deployed on. Optional because the nudge is promptness and never
  // delivery: a context without the binding discharges nothing and the
  // dispatcher's perpetual alarm still runs the job.
  JOB_DISPATCHER?: JobDispatcherNamespace;
}

/** The required subset after the fail-fast gate has run. */
export interface RequiredBindings {
  readonly DATABASE_URL: string;
  readonly UPSTASH_REDIS_REST_URL: string;
  readonly UPSTASH_REDIS_REST_TOKEN: string;
  readonly IRON_SESSION_SECRET: string;
}

/**
 * Per-request DI surface. Populated by the pipeline middleware in order
 * (env → bindings → session → authorize); handlers and slice code consume
 * these and never touch raw `c.env`.
 */
export interface Variables {
  envUtils: EnvUtilities;
  bindings: RequiredBindings;
  /**
   * The per-request pool, carrying the job-wake capability the bindings stage
   * granted: an opener merges whatever its transaction collected back onto
   * this handle on commit, and the stage discharges the result once the
   * response is done.
   */
  db: JobWakeCapable<Database>;
  redis: Redis;
  // The typed SafeLogFields port (compile-time-literal messages, allowlisted
  // fields) — routes and slices type against this, never a permissive logger.
  logger: Telemetry;
  principal: Principal;
  /**
   * The class the authorizer resolved off this request's matched handlers.
   * Absent when nothing but the pipeline matched, which is the 404 the
   * authorizer falls through to. It is set there rather than re-derived by
   * each consumer: the resolution refuses a route declaring two classes, and a
   * second walk that disagreed with the first would authorize against one
   * class and bound against the other.
   */
  routeClass: RouteClass;
  /**
   * Registers work that outlives the response. The bindings stage settles every
   * registered task before it closes the per-request Postgres pool, so a
   * side-band may still read `c.var.db` after the handler returned. A raw
   * `c.executionCtx.waitUntil` races that teardown and its query is rejected,
   * so post-response work belongs here — including work that does not touch the
   * pool today, since the next edit to it might.
   *
   * A task runs from the moment it is created, not from the handler's return,
   * and the pool refuses a statement issued while another is in flight: a
   * side-band's pool use must not overlap the handler's own, nor another
   * side-band's.
   */
  sideBand: (task: Promise<unknown>) => void;
  /**
   * The classification of the availability refusal this request was answered
   * with, recorded by the refusal tail on every such refusal and read after the
   * response by the request line logged outside production. Absent on a request
   * no availability refusal answered.
   */
  dependencyFailure: DependencyFailure;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
