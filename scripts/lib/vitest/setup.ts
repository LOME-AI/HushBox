/**
 * Vitest setup file — provisions the worker's own database and installs a
 * network-block guard so a test can't make an unexpected real external call.
 * Imported via the shared vitest config in packages/config/vitest.config.ts.
 *
 * Nothing here tells the stack the run is alive. Whether the idle daemon tears
 * the stack down mid-run is decided outside this file, on the terms in
 * `scripts/lib/stack/idle-killer.ts` — a vitest worker supplies none of them.
 *
 * Dependency-light by rule — this file is loaded by every Vitest worker. The
 * one cross-package import is `@hushbox/db/test-db`, which is itself
 * dependency-free; the database-provisioning driver, which is not, is behind a
 * dynamic import rather than a static one.
 */
import { RUN_TOKEN_VARIABLE } from '@hushbox/db/test-db';
import { installRedisRunScope } from './redis-scope.js';

/**
 * Whether the realm this setup file was loaded into is Node's, rather than a
 * DOM emulator's (`jsdom`, `happy-dom`) — both of which install a `window`.
 */
export function isNodeRealm(globalScope: { readonly window?: unknown }): boolean {
  return globalScope.window === undefined;
}

/*
 * Per-worker Postgres database.
 *
 * Vitest re-runs this file for every test file and restores `process.env` (and
 * the worker's globals) each time, so nothing can be remembered between files:
 * every file re-attempts the clone. That is why creation is idempotent — the
 * second attempt onward is a `duplicate_database` no-op costing one round trip.
 *
 * Awaited at module scope, which is what puts the rewritten `DATABASE_URL` in
 * place before any test module is evaluated — integration suites read it at
 * import time.
 *
 * Node-realm files only. For jsdom that is a hard constraint: the Neon driver
 * dials Postgres with a bare `new WebSocket(url)`, which resolves the realm's
 * global; jsdom's delegates to undici's, whose `fireEvent` builds a jsdom `Event`
 * and dispatches it at a Node `EventTarget`, so the dial dies with
 * `ERR_INVALID_ARG_TYPE` ("must be an instance of Event. Received an instance of
 * Event") — undici/lib/web/websocket/util.js → node:internal/event_target.
 * For happy-dom it is a deliberate saving rather than a constraint: happy-dom
 * installs its own `WebSocket`, so undici's is never entered and a happy-dom file
 * provisions and queries Postgres fine (measured). The predicate is still keyed
 * to realm shape rather than narrowed to jsdom by choice — the isolation a
 * jsdom-only predicate would buy is isolation nobody uses, and keying on one
 * emulator by name is more brittle. No DOM-environment suite touches Postgres, so
 * a skipped clone leaves `DATABASE_URL` unrewritten for files that never read it —
 * a DOM-environment test that did need the database would silently share the
 * base one, and belongs in a node-environment file instead.
 */
/* v8 ignore start -- provisioning I/O; the logic lives in test-db-provision.ts */
const poolId = process.env['VITEST_POOL_ID'];
if (poolId !== undefined && isNodeRealm(globalThis)) {
  const runToken = process.env[RUN_TOKEN_VARIABLE];
  if (runToken === undefined || runToken === '') {
    throw new Error(
      `vitest-setup: ${RUN_TOKEN_VARIABLE} is unset — the vitest global setup did not run`
    );
  }
  const { provisionSlotDatabase } = await import('../test-run/test-db-provision.js');
  await provisionSlotDatabase(process.env, poolId);
}
/* v8 ignore stop */

/*
 * Network-block guard (audit F59).
 *
 * Tests hit real LOCAL infra over HTTP — the Neon proxy, Serverless-Redis-HTTP,
 * MinIO and Wrangler, each on the port the allocator gave this checkout's slot
 * and stack (`scripts/lib/stack/port-plan.ts`) — but must never make an
 * unexpected REAL external call: AI calls go through the cassette layer, which
 * records on a miss (the first uncached call is real, replayed thereafter) — a
 * warm cache means zero live AI calls. This wraps `globalThis.fetch` so
 * loopback hosts delegate to the real fetch and any other host throws.
 *
 * Inert in the TRUSTED CI phase alone. The intentional real-API /
 * `verify:evidence` tests deliberately reach external hosts, and that phase's
 * AI-call net is the record-on-miss cassette layer (real fetch on a miss, then
 * replay from the cassette store), not this coarse stub.
 *
 * The flag alone no longer names that phase. Both phases run with `CI` set, and
 * the untrusted one runs contributor code against development-mode
 * configuration — the single phase with no net was the single phase that most
 * needs one. So this follows the same distinction the model-adapter provider
 * gate follows: the credential the generated configuration carries, never the
 * ambient flag. The term is a credential the CI-vitest configuration defines
 * and the development one does not, rather than the development placeholder's
 * value, so no copy of that value lives here to drift out of step with the
 * registry.
 *
 * Inert in the workerd pool too: those projects (`vitest.workers.config.ts`)
 * are standalone configs that never load this setup file, so nothing here runs
 * under `@cloudflare/vitest-pool-workers`.
 *
 * `process.env` is read directly (not `createEnvUtilities`) because this file
 * must stay dependency-light — it cannot import `@hushbox/shared`.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Resolve the target hostname from any fetch input; relative URLs → localhost. */
export function resolveTargetHost(input: string | URL | Request): string | undefined {
  let raw: string;
  if (typeof input === 'string') {
    raw = input;
  } else if (input instanceof URL) {
    raw = input.href;
  } else {
    raw = input.url;
  }
  try {
    // Base makes relative URLs resolve to localhost (a local target); data:/
    // blob: URLs resolve to an empty host (no network).
    return new URL(raw, 'http://localhost').hostname;
  } catch {
    return undefined;
  }
}

/** Loopback, the reserved `.localhost` TLD, and the empty host all count as local. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  return host === '' || host.endsWith('.localhost') || LOOPBACK_HOSTS.has(host);
}

/**
 * The credentials the CI-vitest configuration defines and the development
 * configuration the untrusted phase runs against does not
 * (`packages/shared/src/env/env.config.ts`). Their presence is what tells the two
 * continuous-integration phases apart, since the ambient flag no longer can:
 * a run holding one of these is the trusted phase whose real-API tests mean to
 * reach external hosts. A name drifting out of the registry costs a guard that
 * stays armed in the trusted phase — loud, and the safe direction.
 */
const TRUSTED_PHASE_CREDENTIALS = [
  'LINEAR_API_KEY_READ',
  'FCM_PROJECT_ID_CI',
  'FCM_SERVICE_ACCOUNT_JSON_CI',
] as const;

/**
 * Enabled everywhere except the trusted CI phase. The term beyond the flag is
 * the point: an unprovisioned or empty value counts as absent, so a run that
 * cannot make a real call cannot disarm the net that stops one.
 */
export function networkGuardEnabled(env: NodeJS.ProcessEnv): boolean {
  const carriesCredential = TRUSTED_PHASE_CREDENTIALS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
  return !(Boolean(env['CI']) && carriesCredential);
}

/** Wrap a fetch so external hosts throw and local hosts pass through. */
export function createNetworkGuard(realFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return function guardedFetch(input, init) {
    const host = resolveTargetHost(input as string | URL | Request);
    if (host === undefined || isLocalHost(host)) {
      return realFetch(input, init);
    }
    throw new Error(
      `network access blocked in tests: fetch to "${host}" — use a cassette or a ` +
        'scripted/mock fetch (see docs/CODE-RULES.md: the CI hot path is 100% cassette hits).'
    );
  };
}

/* v8 ignore start -- global install runs once on import; the guard logic above is unit-tested */
if (networkGuardEnabled(process.env)) {
  globalThis.fetch = createNetworkGuard(globalThis.fetch.bind(globalThis));
}
/* v8 ignore stop */

/*
 * Per-run Redis scope.
 *
 * The counterpart to the per-worker database above, for the one store that has
 * no per-run instance to hand out: two concurrent runs share one logical Redis,
 * so without this every run reads and writes the same keys. Installed over the
 * network guard rather than under it, so a scoped request still passes through
 * the guard; and installed only when the harness minted a run token, which is
 * what keeps every non-vitest process — production included — on the untouched
 * global fetch. Rationale: `scripts/lib/vitest/redis-scope.ts`.
 */
/* v8 ignore start -- global install runs once on import; the scoping logic is unit-tested */
installRedisRunScope(process.env, globalThis);
/* v8 ignore stop */
