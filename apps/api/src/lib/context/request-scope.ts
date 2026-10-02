import { AsyncLocalStorage } from 'node:async_hooks';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { Context, MiddlewareHandler } from 'hono';
import type { JobWakeCapable } from '../jobs/index.js';
import type { Telemetry } from '../telemetry/index.js';
import type { AppEnv, Bindings } from './app-env.js';
import type { Principal } from './principal.js';

/**
 * The per-request variables the ambient scope carries: a subset of the
 * pipeline's `Variables` chosen here rather than derived from it, so a
 * variable added to the pipeline does not arrive here on its own. The names
 * are chosen; their types are still the pipeline's, through
 * {@link ScopedValues}.
 *
 * These names are spelled a second time as string literals in
 * `packages/config/eslint-extensions/rules/no-bare-scoped-set.mjs`, the gate
 * refusing a bare `c.set` of one of them, because an ESLint rule cannot import
 * a type. The architecture rule
 * `packages/config/arch/rules/scoped-set-gate-matches-the-scoped-type.rule.ts`
 * holds the two lists equal, so a name added to one alone is refused at the
 * gate.
 */
type ScopedVariable = 'db' | 'redis' | 'logger' | 'principal';

/** The scoped variables' types, taken from the pipeline's own `Variables`. */
type ScopedValues = { [K in ScopedVariable]: AppEnv['Variables'][K] | undefined };

/**
 * What a request makes available to code that holds no `Context` — the
 * composition-root adapters bound as STATIC slice deps, which resolve their
 * per-request infrastructure at call time.
 *
 * It is a MUTABLE RECORD OF VALUES, and that is the whole design constraint
 * rather than an implementation detail. workerd's `Response` captures the
 * AsyncContextFrame current at its construction, so anything an
 * AsyncLocalStorage store can reach that reaches the response back closes a
 * cycle the runtime never collects — the request's whole object graph, pinned
 * for the isolate's lifetime. Holding the `Context` (which holds `c.res`) is
 * that shape, and so is any getter, proxy or closure here that reads through
 * to one: this record must therefore be filled by the stages as they resolve
 * each value, never derived from a `Context` on read. The contract is pinned
 * by `apps/api/src/middleware/request-scope.workers.test.ts`.
 *
 * Every field but `env` is bound after the scope is entered, so each is
 * readable as absent; the accessors below are what turn absence into a named
 * failure instead of an `undefined` deep in a caller.
 */
type RequestScope = { readonly env: Bindings } & ScopedValues;

const requestScopeStorage = new AsyncLocalStorage<RequestScope>();

const enterRequestScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  await requestScopeStorage.run(
    { env: c.env, db: undefined, redis: undefined, logger: undefined, principal: undefined },
    next
  );
};

/**
 * Enters a fresh ambient scope for the request. Mounted in the edge ring, so
 * every later stage's `bindRequestValue` lands in this request's record and
 * every handler runs inside it. The record is per request; the handler that
 * creates it holds nothing, so one instance serves every mount.
 */
export function requestScope(): MiddlewareHandler<AppEnv> {
  return enterRequestScope;
}

/**
 * Binds one per-request value to BOTH surfaces that expose it: `c.var` for
 * everything holding the context, and the ambient scope for everything that
 * does not. One function rather than two writes at each call site — the two
 * surfaces must answer with the same value, and a second write is exactly the
 * thing that drifts.
 *
 * A composition with no scope entered (a test mounting a single stage) still
 * gets the `c.var` write: `c.var` is the surface such a composition reads, and
 * the ambient scope belongs to the ring that was not mounted.
 */
export function bindRequestValue<K extends ScopedVariable>(
  c: Context<AppEnv>,
  key: K,
  value: AppEnv['Variables'][K]
): void {
  c.set(key, value);
  const scope = requestScopeStorage.getStore();
  if (scope === undefined) return;
  // Narrowed to the written half of the record: a generic keyed write against
  // the whole type does not typecheck, because `env` has no counterpart to
  // write.
  const values: ScopedValues = scope;
  values[key] = value;
}

/** The current request's scope; absent outside one. */
function currentScope(): RequestScope {
  const scope = requestScopeStorage.getStore();
  if (scope === undefined) {
    throw new Error('request scope: no request is in scope (the edge ring did not run)');
  }
  return scope;
}

/** Fail fast rather than hand back an unbound value under a non-optional type. */
function requireBound<T>(value: T | undefined, name: ScopedVariable): T {
  if (value === undefined) {
    throw new Error(`request scope: ${name} is not bound (the stage that binds it did not run)`);
  }
  return value;
}

/** The current request's Worker bindings. */
export function requestEnv(): Bindings {
  return currentScope().env;
}

/** The current request's database handle, carrying its job-wake capability. */
export function requestDb(): JobWakeCapable<Database> {
  return requireBound(currentScope().db, 'db');
}

/** The current request's Redis client. */
export function requestRedis(): Redis {
  return requireBound(currentScope().redis, 'redis');
}

/** The current request's telemetry port. */
export function requestLogger(): Telemetry {
  return requireBound(currentScope().logger, 'logger');
}

/** The principal the session and admin stages resolved for this request. */
export function requestPrincipal(): Principal {
  return requireBound(currentScope().principal, 'principal');
}
