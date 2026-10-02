/**
 * The retention gate over the WHOLE request ring: after a request has run
 * through every stage the app assembly mounts, nothing the ambient request
 * scope carries may keep that request's Hono `Context` alive.
 *
 * Why the ring and not one stage: `bindRequestValue` accepts any value of the
 * scoped key's type, and `Telemetry`, `Database` and `Redis` are
 * objects-of-methods, so a value whose methods close over the `Context`
 * typechecks and reintroduces the cycle. Nothing else refuses it — not the
 * types, not lint, and explicitly not the structural walk in
 * `apps/api/src/middleware/request-scope.workers.test.ts`, whose docblock
 * records that a variable captured by a closure is not a property of anything
 * and is therefore invisible to it.
 *
 * Why the question is a boolean rather than a byte count: a reachable object is
 * never reclaimed by V8, so "was it collected" has no noise band at any host
 * load — no threshold to justify, and no retention permitted.
 *
 * Why the node project rather than workerd: the runtime offers no forced
 * collection from inside a test. What is measured here is V8's own scope
 * allocation, and the middleware exercised is the shipped composition.
 *
 * Anchoring the ambient stores across the collection is what makes this the
 * Worker's situation: workerd's `Response` captures the AsyncContextFrame
 * current at its construction, so everything the store reaches is retained for
 * the isolate's life.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bindRequestValue } from '../lib/context/index.js';
import { bindRoutePosture } from '../lib/rate-limit/index.js';
import { edgeRing } from './edge-ring.js';
import { applyPipeline } from './pipeline.js';
import { routeClass } from './pipeline-markers.js';
import type { CachePolicyMap } from './pipeline-cache-policy.js';
import type { RoutePostureMap } from './pipeline-rate-limit.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';
import type { Telemetry, TelemetryEnv } from '../lib/telemetry/index.js';
import type { Context, MiddlewareHandler } from 'hono';

const PROBE_PATH = '/ring-retention-probe';
const PROBE_KEY = '$get /ring-retention-probe';

/**
 * The per-request record a deployed request arrives with, with the PRODUCTION
 * sink list. That is load-bearing rather than incidental: the console sink's
 * methods close over nothing, so under `'console'` alone nothing retains the
 * flush scheduler the binding stage hands the Sentry sink, and a capture
 * re-introduced inside that scheduler would be invisible here. Binding console
 * only is what made every gate that existed before this one blind to exactly
 * that shape.
 *
 * `RATE_LIMIT_REDIS_TIMEOUT_MS` is deliberately absent: the node project's
 * setup file already put the isolate's bound in force from the process
 * environment, and a record stating no value can only establish a bound, never
 * contradict one.
 *
 * The three web origins are what CORS resolves for itself in the edge ring,
 * which runs ahead of the binding gate and so fails fast on its own.
 */
const RING_BINDINGS: Bindings &
  TelemetryEnv & {
    readonly FRONTEND_URL: string;
    readonly FRONTEND_PREVIEW_URL: string;
    readonly MARKETING_URL: string;
  } = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console,sentry',
  SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42',
  FRONTEND_URL: 'https://app.invalid',
  FRONTEND_PREVIEW_URL: 'https://preview.invalid',
  MARKETING_URL: 'https://marketing.invalid',
};

/**
 * Counted in flow, so the posture stage spends no round trip: the Redis these
 * bindings name answers nothing, and what this file observes is the object
 * graph, not the counter.
 */
const inFlowOnly = {
  kind: 'throttle',
  maxAttempts: 4,
  windowSeconds: 60,
  buildKey: (id: string) => `ring-retention-fixture:in-flow:${id}`,
} as const satisfies ThrottleLimit;

const postures: RoutePostureMap = {
  [PROBE_KEY]: bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'flow', definition: inFlowOnly }],
  }),
};

const policies: CachePolicyMap = { [PROBE_KEY]: { kind: 'no-store' } };

/** What the probe route hands back to the assertion. */
interface RingProbe {
  contextReference?: WeakRef<object>;
}

/**
 * The whole chain a deployed request runs: the edge ring the app assembly
 * mounts outside the pipeline, then the pipeline itself. `extraStage`, where
 * given, is mounted as the last stage before the route — a stage that is not
 * `pipelineBindings`, which is the point of it.
 */
function buildRingApp(probe: RingProbe, extraStage?: MiddlewareHandler<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  for (const handler of edgeRing()) app.use('*', handler);
  const piped = applyPipeline(app, { rateLimit: { postures }, cache: { policies } });
  if (extraStage !== undefined) piped.use('*', extraStage);
  return piped.get(PROBE_PATH, routeClass('public'), (c) => {
    probe.contextReference = new WeakRef(c);
    return c.json({ probe: true });
  });
}

/**
 * Every value any AsyncLocalStorage is entered with while the request runs.
 * Patching the prototype rather than one known storage is deliberate: the
 * constraint binds whatever installs an ambient scope, including one a later
 * change adds, and a probe that knew the storage by name would not see it.
 */
async function requestHoldingStores(app: Hono<AppEnv>): Promise<{
  readonly stores: readonly unknown[];
  readonly response: Response;
}> {
  const stores: unknown[] = [];
  const original = AsyncLocalStorage.prototype.run;
  AsyncLocalStorage.prototype.run = function patched<R, TArgs extends unknown[]>(
    this: AsyncLocalStorage<unknown>,
    store: unknown,
    callback: (...args: TArgs) => R,
    ...args: TArgs
  ): R {
    stores.push(store);
    return original.call<AsyncLocalStorage<unknown>, [unknown, (...args: TArgs) => R, ...TArgs], R>(
      this,
      store,
      callback,
      ...args
    );
  };
  try {
    const response = await app.request(PROBE_PATH, {}, RING_BINDINGS);
    return { stores, response };
  } finally {
    AsyncLocalStorage.prototype.run = original;
  }
}

/**
 * A full collection on demand. `--expose-gc` is a V8 flag rather than a Node
 * one, so it can be set after start-up and `gc` read off a fresh V8 context —
 * which keeps this assertion inside the ordinary package run instead of
 * needing its own process flags.
 *
 * `runInNewContext` is typed `any`; the annotation names the one value V8 puts
 * under that global, and nothing else here reads it.
 */
const forceCollection: () => void = (() => {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
})();

/**
 * Whether the referent is gone. The yield before each collection is required,
 * not padding: a `WeakRef` target stays alive for the remainder of the job in
 * which `deref` last observed it, so a collection can only reclaim it in a
 * later macrotask. Several attempts because V8 owes no promise about how much
 * one call reclaims; a live referent survives all of them.
 */
async function isCollected(reference: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await nextMacrotask();
    forceCollection();
    if (reference.deref() === undefined) return true;
  }
  return false;
}

/**
 * The defect shape, kept executable: a scoped value whose methods close over
 * the request `Context`. It typechecks against the key's declared type —
 * every scoped key is an object of methods, so nothing in the type system
 * separates this from a legitimate implementation — and every request it runs
 * on retains that request's whole graph. `real` is read before the rebind so
 * the delegation terminates; the capture that matters is `c`.
 */
function telemetryClosingOverContext(c: Context<AppEnv>, real: Telemetry): Telemetry {
  return {
    debug: (msg, fields) => {
      if (!c.finalized) real.debug(msg, fields);
    },
    info: (msg, fields) => {
      if (!c.finalized) real.info(msg, fields);
    },
    warn: (msg, fields) => {
      if (!c.finalized) real.warn(msg, fields);
    },
    error: (msg, fields) => {
      if (!c.finalized) real.error(msg, fields);
    },
    captureError: (error, errorCode) => {
      if (!c.finalized) real.captureError(error, errorCode);
    },
  };
}

/** A stage that binds that value — the commit this gate exists to refuse. */
function retainingStage(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    bindRequestValue(c, 'logger', telemetryClosingOverContext(c, c.get('logger')));
    await next();
  };
}

describe('request ring per-request retention', () => {
  it('answers the probe route through the composed ring', async () => {
    const probe: RingProbe = {};
    const { response } = await requestHoldingStores(buildRingApp(probe));

    expect(response.status).toBe(200);
  });

  it('enters exactly one ambient scope, carrying only the scoped keys', async () => {
    // Named here so a reader knows what the gate below covers: every value the
    // request's ambient record holds is what the collection check anchors.
    const probe: RingProbe = {};
    const { stores } = await requestHoldingStores(buildRingApp(probe));
    const keys = stores.map((store) =>
      store !== null && typeof store === 'object'
        ? Reflect.ownKeys(store)
            .map(String)
            .toSorted((left, right) => left.localeCompare(right))
        : []
    );

    expect(keys).toEqual([['db', 'env', 'logger', 'principal', 'redis']]);
  });

  it('leaves the request context collectable once the ring has run', async () => {
    const probe: RingProbe = {};
    const anchor: { stores?: readonly unknown[] } = {};

    const { stores, response } = await requestHoldingStores(buildRingApp(probe));
    anchor.stores = stores;

    expect(response.status).toBe(200);
    const reference = probe.contextReference;
    if (reference === undefined) throw new Error('the probe handler did not run');
    expect(await isCollected(reference)).toBe(true);
    // Anchored on an object and read AFTER the check: V8 may reclaim a local
    // nothing reads again, and this is what makes the ambient record
    // unambiguously live across the collection above.
    expect(anchor.stores).toBeDefined();
  });

  it('reports the context retained when a stage binds a value closing over it', async () => {
    // The gate's own proof. A collection check that could only answer "gone"
    // would pass the case above forever, so the same check is pointed at the
    // shape the gate exists to refuse — a stage other than `pipelineBindings`
    // binding a scoped value whose methods capture the `Context` — and must
    // report it retained.
    const probe: RingProbe = {};
    const anchor: { stores?: readonly unknown[] } = {};

    const { stores, response } = await requestHoldingStores(buildRingApp(probe, retainingStage()));
    anchor.stores = stores;

    expect(response.status).toBe(200);
    const reference = probe.contextReference;
    if (reference === undefined) throw new Error('the probe handler did not run');
    expect(await isCollected(reference)).toBe(false);
    expect(anchor.stores).toBeDefined();
  });
});
