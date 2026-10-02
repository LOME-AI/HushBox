import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import { rateLimitBound } from '../rate-limit/bound.js';
import { createBoundedRedis } from '../resilience/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { RequiredBindings } from './app-env.js';

/**
 * The server-side bound on every statement a request-path session runs: past
 * it Postgres cancels the statement with SQLSTATE 57014, so a hung statement
 * fails as itself instead of holding the request open. Only this creation site
 * asks for it: every other plane connects as the same role and stays
 * unbounded, which rules out a role-level setting.
 *
 * - Inside the ~5 s that request-path work may take at all (longer work runs as
 *   a job), so no one statement can spend the whole budget.
 * - Above the longest legitimate request-path statement measured: the
 *   account-deletion cascade, at 1.8-2.3 s for 50,000 owned messages. Its cost
 *   grows with the account, so that transaction lifts the bound for itself.
 *
 * One value in every mode: a looser local value would let a statement that
 * production cancels pass every local gate.
 */
export const REQUEST_STATEMENT_TIMEOUT_MS = 4000;

/**
 * Per-request client factories (serverless mindset: no module-level
 * singletons; state lives in Postgres/Redis, never the isolate). Callers
 * depend on this seam, not on the @hushbox/db client module directly.
 *
 * The request database is serial: its one connection serves one statement at
 * a time, so a request's reads run one after another, and a second statement
 * issued beside one in flight fails at once rather than waiting out the
 * acquisition deadline behind it.
 */
export function createRequestDb(
  bindings: RequiredBindings,
  envUtilities: { readonly isDev: boolean }
): Database {
  const options = { serial: true, statementTimeoutMs: REQUEST_STATEMENT_TIMEOUT_MS };
  return envUtilities.isDev
    ? createDb(bindings.DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, ...options })
    : createDb(bindings.DATABASE_URL, options);
}

/**
 * The bound on one round trip comes from the entry the bindings stage already
 * put in force for this isolate, not from a value threaded through here: the
 * narrowed bindings deliberately carry no infrastructure timeout, and what a
 * round trip to this store may legitimately take differs by mode, so a constant
 * in this tree could only be right for one of them.
 */
export function createRequestRedis(bindings: RequiredBindings): Redis {
  return createBoundedRedis(
    {
      url: bindings.UPSTASH_REDIS_REST_URL,
      token: bindings.UPSTASH_REDIS_REST_TOKEN,
    },
    rateLimitBound().timeoutMs
  );
}
