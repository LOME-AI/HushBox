import { timeoutPolicy } from '../resilience/index.js';
import type { PolicyRunner } from '../resilience/index.js';

/** The registry entry this module reads, in whatever record carries it. */
export interface RateLimitBoundEnv {
  readonly RATE_LIMIT_REDIS_TIMEOUT_MS?: string | undefined;
}

/** The bound in force, and the runner that enforces it. */
export interface RateLimitBound {
  readonly timeoutMs: number;
  readonly runner: PolicyRunner;
}

const ENTRY = 'RATE_LIMIT_REDIS_TIMEOUT_MS';

/**
 * The bound is per-mode registry data rather than a constant, and the
 * production value is reasoned, not measured — nothing in this system retains
 * a latency observation, so no percentile exists to size it against. It is
 * loosened in every mode that reaches Redis through an emulating proxy, which
 * is every mode but production: there a tight bound measures the proxy and the
 * host its own test run is saturating rather than the endpoint the bound exists
 * to protect, and a check that outran it is indistinguishable from a cap
 * nobody crossed.
 * Which mode carries which value is the `RATE_LIMIT_REDIS_TIMEOUT_MS` entry in
 * `packages/shared/src/env/env.config.ts`.
 *
 * It is held here, at module scope, because a Worker isolate has no ambient
 * environment: bindings arrive per request, so the only alternative is an
 * argument, and that would carry an infrastructure timeout through every
 * rate-limited domain signature. What is held is the isolate's own
 * configuration — one value, identical for every request it serves, carrying
 * no request, user or business state, and costing nothing if the isolate dies.
 * Write-once for the same reason: a single isolate serves a single mode, so a
 * second, different value is a composition defect rather than a reconfiguration
 * — and a loud one, because silently keeping either value would leave every
 * counter check running under a bound its own composition root did not choose.
 */
let bound: RateLimitBound | undefined;

function readTimeoutMs(env: RateLimitBoundEnv): number {
  const raw = env.RATE_LIMIT_REDIS_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    throw new Error(
      `${ENTRY} is missing: every mode declares it in the env registry — ` +
        'set it in wrangler config / .dev.vars rather than falling back to a literal.'
    );
  }
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${ENTRY} must be a positive whole number of milliseconds; got '${raw}'.`);
  }
  return timeoutMs;
}

/**
 * Puts the isolate's bound in force from the environment that carries it — the
 * Worker's bindings at the top of a request, a Durable Object's or the cron's
 * env where it opens its Redis client, the test runner's process environment at
 * setup. Every caller resolves the same mode's registry entry, so a repeat is a
 * no-op that keeps the running policy; a disagreement throws rather than
 * letting one entry point's value silently govern another's counters.
 *
 * An env carrying no entry states no value, so it can only establish the bound,
 * never contradict one: the missing-entry fail-fast is what the FIRST caller
 * meets, and every runtime has one — the Worker's bindings stage, a Durable
 * Object's or the cron's env, the test runner's process environment. All the
 * roots inside one deployment read one env record, so a later caller lacking
 * the entry an earlier one had is a test fixture, not a deployment.
 */
export function configureRateLimitBound(env: RateLimitBoundEnv): void {
  const inForce = bound;
  if (inForce === undefined) {
    const timeoutMs = readTimeoutMs(env);
    bound = { timeoutMs, runner: timeoutPolicy({ timeoutMs }) };
    return;
  }
  const raw = env.RATE_LIMIT_REDIS_TIMEOUT_MS;
  if (raw === undefined || raw === '') return;
  const timeoutMs = readTimeoutMs(env);
  if (timeoutMs !== inForce.timeoutMs) {
    throw new Error(
      `${ENTRY} disagrees with the bound already in force: ${String(inForce.timeoutMs)} then ` +
        `${String(timeoutMs)} — one process serves one mode, so two values is a composition defect.`
    );
  }
}

/**
 * The bound every Redis round trip in this module runs under. Throws when
 * nothing has configured it: an unbounded check is the defect this exists to
 * close, so a composition that never configured one fails rather than silently
 * reverting to it.
 */
export function rateLimitBound(): RateLimitBound {
  if (bound === undefined) {
    throw new Error(
      `rate limit bound is not configured: ${ENTRY} reaches this module through ` +
        'configureRateLimitBound, which the request pipeline calls before any counter check.'
    );
  }
  return bound;
}
