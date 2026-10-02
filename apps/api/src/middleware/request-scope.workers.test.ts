/**
 * The retention contract for the request chain's ambient scope: while a
 * request runs, no AsyncLocalStorage store may reach that request's Hono
 * `Context`, its `Request` or its `Response`.
 *
 * Why the constraint exists, and why it is not a byte count: workerd's
 * `Response` captures the AsyncContextFrame current at its construction, so a
 * store that reaches the response closes a cycle
 * (`Response → frame → store → … → Response`) the runtime never collects — one
 * whole request graph pinned for the isolate's lifetime. The runtime offers no
 * forced collection from inside a test and a `WeakRef` probe is
 * nondeterministic by construction, so this asserts the reachability that
 * causes the cycle rather than the bytes that follow from it.
 *
 * Why it runs on workerd rather than in the node project: the `Response` this
 * walk looks for is workerd's, produced by the same runtime whose frame
 * capture the constraint is about.
 *
 * What it cannot see: a variable captured by a closure is not a property of
 * anything, so a function in the store that closes over the `Context` is
 * invisible to this walk. Reachability through properties, array elements,
 * collection entries and getters is what is measured here.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { Context, Hono } from 'hono';
import { applyPipeline } from './pipeline.js';
import { edgeRing } from './edge-ring.js';
import { routeClass } from './pipeline-markers.js';
import { bindRoutePosture } from '../lib/rate-limit/index.js';
import { WORKERS_PIPELINE_BINDINGS } from '../test-support/workers-pipeline-bindings.js';
import type { CachePolicyMap } from './pipeline-cache-policy.js';
import type { RoutePostureMap } from './pipeline-rate-limit.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';

const PROBE_PATH = '/retention-probe';
const PROBE_KEY = '$get /retention-probe';

/**
 * The shared pipeline record plus the web origins CORS resolves itself: the
 * edge ring runs ahead of the binding gate, so it fails fast on its own before
 * any stage this file is about has run. The preview origin is included by mode
 * rather than by presence, and this record's mode is one that includes it.
 */
const PROBE_BINDINGS: Bindings & {
  readonly FRONTEND_URL: string;
  readonly FRONTEND_PREVIEW_URL: string;
  readonly MARKETING_URL: string;
} = {
  ...WORKERS_PIPELINE_BINDINGS,
  FRONTEND_URL: 'https://app.invalid',
  FRONTEND_PREVIEW_URL: 'https://preview.invalid',
  MARKETING_URL: 'https://marketing.invalid',
};

/**
 * How many objects the walk may visit before it gives up. The graph under a
 * request's infrastructure is large (a Drizzle instance alone carries hundreds
 * of query builders), so the bound is generous — and hitting it is a failure,
 * never a quiet stop, because a walk that ended early proves nothing.
 */
const WALK_BOUND = 100_000;

/**
 * Counted in flow so the posture stage spends nothing: the Redis these
 * bindings name answers nothing, and what this file observes is the ambient
 * scope, not the counter.
 */
const inFlowOnly = {
  kind: 'throttle',
  maxAttempts: 4,
  windowSeconds: 60,
  buildKey: (id: string) => `request-scope-fixture:in-flow:${id}`,
} as const satisfies ThrottleLimit;

const postures: RoutePostureMap = {
  [PROBE_KEY]: bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'flow', definition: inFlowOnly }],
  }),
};

const policies: CachePolicyMap = { [PROBE_KEY]: { kind: 'no-store' } };

/**
 * The whole chain a deployed request runs: the edge ring the app assembly
 * mounts outside the pipeline, then the pipeline itself. The route answers
 * with `c.json`, which is the case that matters — a response constructed
 * inside the request's own frame.
 */
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  for (const handler of edgeRing()) app.use('*', handler);
  return applyPipeline(app, { rateLimit: { postures }, cache: { policies } }).get(
    PROBE_PATH,
    routeClass('public'),
    (c) => c.json({ probe: true })
  );
}

/**
 * Every value any AsyncLocalStorage is entered with while the callback runs.
 * Patching the prototype rather than one known storage is deliberate: the
 * constraint binds whatever installs an ambient scope, including one a later
 * change adds, and a probe that knew the storage by name would not see it.
 */
async function storesEnteredDuring(run: () => Promise<Response>): Promise<{
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
    const response = await run();
    return { stores, response };
  } finally {
    AsyncLocalStorage.prototype.run = original;
  }
}

/** What a reached object is, when it is one of the three the constraint names. */
function requestObjectKind(value: object): string | undefined {
  if (value instanceof Context) return 'Hono Context';
  if (value instanceof Response) return 'Response';
  if (value instanceof Request) return 'Request';
  return undefined;
}

/** Where a walk step came from, and what it led to. */
interface Edge {
  readonly step: string;
  readonly next: unknown;
}

/** The entries of a Map or Set, or nothing when the value is neither. */
function collectionEdges(value: object): Edge[] {
  if (value instanceof Map) {
    return [...value].flatMap(([key, entry], index) => [
      { step: `.get(#${String(index)})`, next: entry },
      { step: `.key(#${String(index)})`, next: key },
    ]);
  }
  if (value instanceof Set) {
    return [...value].map((entry, index) => ({ step: `.entry(#${String(index)})`, next: entry }));
  }
  return [];
}

/**
 * One own property's edge: the stored value, or what its getter answers.
 * Getters are invoked because a read-through view is exactly the shape this
 * walk exists to catch; one that refuses to answer (`Context.executionCtx`
 * throws) leads nowhere, which is the only fact the walk needs from it.
 */
function propertyEdge(value: object, key: string | symbol): Edge | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  const step = `.${String(key)}`;
  if ('value' in descriptor) return { step, next: descriptor.value };
  const read = descriptor.get;
  if (read === undefined) return undefined;
  try {
    return { step, next: read.call(value) };
    // eslint-disable-next-line catch-swallow/no-silent-catch -- a getter that refuses to answer leads nowhere; that absence IS the handling
  } catch {
    return undefined;
  }
}

/** Every value one object leads to. */
function edgesOf(value: object): Edge[] {
  if (Array.isArray(value)) {
    return value.map((element, index) => ({ step: `[${String(index)}]`, next: element }));
  }
  const collection = collectionEdges(value);
  if (collection.length > 0) return collection;
  return Reflect.ownKeys(value)
    .map((key) => propertyEdge(value, key))
    .filter((edge): edge is Edge => edge !== undefined);
}

/** True for the values a walk can step through at all. */
function isWalkable(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** One object the walk reached, and how it got there. */
interface WalkNode {
  readonly value: object;
  readonly path: string;
}

/** What one reached object settles: a finding, the bound, or more walking. */
type Step =
  | { readonly kind: 'continue' }
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'gave-up'; readonly path: string };

/** Records what `node` is, or queues everything it leads to. */
function stepInto(node: WalkNode, visited: number, queue: WalkNode[]): Step {
  if (visited > WALK_BOUND) {
    return { kind: 'gave-up', path: `${node.path} — gave up after ${String(WALK_BOUND)} objects` };
  }
  const reached = requestObjectKind(node.value);
  if (reached !== undefined) return { kind: 'found', path: `${node.path} → ${reached}` };
  for (const edge of edgesOf(node.value)) {
    if (isWalkable(edge.next)) queue.push({ value: edge.next, path: `${node.path}${edge.step}` });
  }
  return { kind: 'continue' };
}

/** Every path from `root` to a `Context`, `Request` or `Response`, shortest first. */
function pathsToRequestObjects(root: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const queue: WalkNode[] = isWalkable(root) ? [{ value: root, path: '<store>' }] : [];
  for (const node of queue) {
    if (seen.has(node.value)) continue;
    seen.add(node.value);
    const step = stepInto(node, seen.size, queue);
    if (step.kind === 'continue') continue;
    found.push(step.path);
    if (step.kind === 'gave-up') break;
  }
  return found;
}

describe('the request chain runs on workerd', () => {
  it('is the runtime the Worker is deployed to', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
});

describe('ambient request scope: what the middleware chain stores', () => {
  it('enters an ambient scope while the request runs', async () => {
    const { stores } = await storesEnteredDuring(
      async () => await buildApp().request(PROBE_PATH, {}, PROBE_BINDINGS)
    );
    expect(stores.length).toBeGreaterThan(0);
  });

  it('answers the probe route', async () => {
    const { response } = await storesEnteredDuring(
      async () => await buildApp().request(PROBE_PATH, {}, PROBE_BINDINGS)
    );
    expect(response.status).toBe(200);
  });

  it('carries only the values the ambient consumers read', async () => {
    const { stores } = await storesEnteredDuring(
      async () => await buildApp().request(PROBE_PATH, {}, PROBE_BINDINGS)
    );
    const keys = stores.map((store) =>
      isWalkable(store)
        ? Reflect.ownKeys(store)
            .map(String)
            .toSorted((left, right) => left.localeCompare(right))
        : []
    );
    expect(keys).toEqual([['db', 'env', 'logger', 'principal', 'redis']]);
  });

  it('stores nothing that reaches the request context, request or response', async () => {
    const { stores } = await storesEnteredDuring(
      async () => await buildApp().request(PROBE_PATH, {}, PROBE_BINDINGS)
    );
    const reached = stores.flatMap((store) => pathsToRequestObjects(store));
    expect(reached).toEqual([]);
  });
});

/**
 * The probe's own proof. A walk that reported nothing because it looked at
 * nothing would pass the assertion above forever, so the same probe is pointed
 * at the shape the fix removed — an ambient store that IS the request context —
 * and must report it. This is the failure the invariant test showed before the
 * app-owned scope replaced hono's context storage, kept executable.
 */
describe('the probe detects a store that reaches the request', () => {
  it('reports the path when the store is the context itself', async () => {
    const contextStore = new AsyncLocalStorage<unknown>();
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        await contextStore.run(c, next);
      })
      .get(PROBE_PATH, (c) => c.json({ probe: true }));
    const { stores } = await storesEnteredDuring(
      async () => await app.request(PROBE_PATH, {}, PROBE_BINDINGS)
    );
    expect(stores.flatMap((store) => pathsToRequestObjects(store))).toEqual([
      '<store> → Hono Context',
    ]);
  });
});
