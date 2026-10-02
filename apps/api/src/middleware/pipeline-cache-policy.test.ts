import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { applyPipeline } from './pipeline.js';
import { pipelineCachePolicy } from './pipeline-cache-policy.js';
import { pipelineEnv } from './pipeline-env.js';
import { cors } from './cors.js';
import { MAX_REQUEST_BODY_BYTES } from './body-limit.js';
import { edgeRing } from './edge-ring.js';
import { markPipelineHandler, routeClass } from './pipeline-markers.js';
import type { CachePolicyMap } from './pipeline-cache-policy.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { Context, MiddlewareHandler } from 'hono';
import type { RoutePostureMap } from './pipeline-rate-limit.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** The registry entries these fixtures read, typed where the bindings gate does not narrow them. */
type TestEnv = Bindings &
  TelemetryEnv & {
    FRONTEND_URL?: string;
    FRONTEND_PREVIEW_URL?: string;
    MARKETING_URL?: string;
    APP_VERSION?: string;
  };

const devEnv: TestEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

/**
 * Policies for `buildApp`'s routes, in the same shape the composition root
 * supplies: one entry per declared route key, and deliberately none for
 * `/unpoliced`, which is what the default-deny answers.
 */
const policies: CachePolicyMap = {
  '$get /no-store': { kind: 'no-store' },
  '$get /shared': {
    kind: 'shared',
    sharedMaxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 600,
    tag: 'fixture-shared',
  },
  '$get /immutable': { kind: 'immutable', maxAgeSeconds: 86_400, tag: 'fixture-immutable' },
  '$get /storable-handler': { kind: 'no-store' },
  '$get /shared-throttled': { kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'fixture-throttled' },
  '$get /multi-mixed/:id': { kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'fixture-mixed' },
  '$get /multi-agree/:id': { kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'fixture-agree' },
  '$get /multi-agree/known': { kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'fixture-agree' },
};

const postures: RoutePostureMap = {
  '$get /no-store': { kind: 'default', failure: 'open' },
  '$get /shared': { kind: 'default', failure: 'open' },
  '$get /immutable': { kind: 'default', failure: 'open' },
  '$get /storable-handler': { kind: 'default', failure: 'open' },
  '$get /unpoliced': { kind: 'default', failure: 'open' },
  '$get /unpoliced-storable': { kind: 'default', failure: 'open' },
  '$get /multi-mixed/:id': { kind: 'default', failure: 'open' },
  '$get /multi-mixed/known': { kind: 'default', failure: 'open' },
  '$get /multi-agree/:id': { kind: 'default', failure: 'open' },
  '$get /multi-agree/known': { kind: 'default', failure: 'open' },
};

/** Typed JSON read severed from hono's Response inference (json() is unknown here). */
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A handler opting itself in, which is exactly what the stage must overrule. */
const storableHandler: MiddlewareHandler<AppEnv> = async (c) => {
  c.header('Cache-Control', 'public, s-maxage=3600');
  c.header('Cache-Tag', 'smuggled');
  return await Promise.resolve(c.json({ ok: true }));
};

function buildApp(options?: { readonly policies?: CachePolicyMap }): Hono<AppEnv> {
  return (
    applyPipeline(new Hono<AppEnv>(), {
      rateLimit: { postures },
      cache: options ?? { policies },
    })
      .get('/no-store', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/shared', routeClass('public'), (c) =>
        c.req.query('defect') === undefined ? c.json({ ok: true }) : c.json({ ok: false }, 500)
      )
      // Declared cacheable, deliberately undeclared to the posture gate, which
      // answers 429 before the handler runs.
      .get('/shared-throttled', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/immutable', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/unpoliced', routeClass('public'), (c) => c.json({ ok: true }))
      // Two registrations matching one path: the parameterised one is declared
      // cacheable and its literal sibling is not, so the two disagree.
      .get('/multi-mixed/:id', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/multi-mixed/known', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/multi-agree/:id', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/multi-agree/known', routeClass('public'), (c) => c.json({ ok: true }))
      .get('/storable-handler', routeClass('public'), storableHandler)
      .get('/unpoliced-storable', routeClass('public'), storableHandler)
  );
}

describe('pipelineCachePolicy: the default deny', () => {
  it('refuses storage of a route declaring a no-store policy', async () => {
    const res = await buildApp().request('/no-store', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('refuses storage of a matched route the policy map does not declare', async () => {
    const res = await buildApp().request('/unpoliced', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('names no purge tag on a response it refuses storage of', async () => {
    const res = await buildApp().request('/no-store', {}, devEnv);
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });
});

describe('pipelineCachePolicy: a declared policy', () => {
  it('emits the shared-cache directives its policy declares', async () => {
    const res = await buildApp().request('/shared', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=30, stale-if-error=600'
    );
  });

  it('emits the purge tag its policy declares', async () => {
    const res = await buildApp().request('/shared', {}, devEnv);
    expect(res.headers.get('Cache-Tag')).toBe('fixture-shared');
  });

  it('emits the immutable directives its policy declares', async () => {
    const res = await buildApp().request('/immutable', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
  });
});

describe('pipelineCachePolicy: a status the policy does not license', () => {
  it('refuses storage of a declared-cacheable route answering a defect', async () => {
    const res = await buildApp().request('/shared?defect', {}, devEnv);
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('names no purge tag on a declared-cacheable route answering a defect', async () => {
    const res = await buildApp().request('/shared?defect', {}, devEnv);
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  it('refuses storage of a declared-cacheable route the posture gate throttles', async () => {
    const res = await buildApp().request('/shared-throttled', {}, devEnv);
    expect(res.status).toBe(429);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('pipelineCachePolicy: a path matching several registrations', () => {
  it('refuses storage when the matched registrations disagree', async () => {
    const res = await buildApp().request('/multi-mixed/known', {}, devEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('emits the declared directives when every matched registration agrees', async () => {
    const res = await buildApp().request('/multi-agree/known', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60');
  });
});

describe('pipelineCachePolicy: a path matching no route', () => {
  it('refuses storage of the not-found answer', async () => {
    const res = await buildApp().request('/no-such-route', {}, devEnv);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('refuses storage of a 200 no route registration matched', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineCachePolicy({ policies }))
      .use('*', storableHandler);
    const res = await app.request('/anything', {}, devEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

/**
 * A completed protocol switch as the node project can express one: undici
 * refuses to construct any status below 200, so the switch is stamped onto a
 * real `Response` afterwards. It carries no socket, which is why the shape the
 * Worker actually returns — a live `WebSocketPair` on a Durable Object's `101`
 * — is pinned in this module's `*.workers.test.ts` against the real runtime.
 * This fixture pins the same decision where the rest of the stage's cases live.
 */
function protocolSwitchResponse(): Response {
  const response = new Response(null, { status: 204 });
  Object.defineProperty(response, 'status', { value: 101 });
  return response;
}

describe('pipelineCachePolicy: a completed protocol switch', () => {
  it('writes no cache directives onto the upgrade response', async () => {
    // Mounted without the rest of the pipeline deliberately: a stage reading
    // `c.res` ahead of the handler makes hono rebuild the response, and
    // rebuilding a 101 is what undici refuses.
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineCachePolicy({ policies }))
      .get('/upgrade', () => protocolSwitchResponse());
    const res = await app.request('/upgrade', {}, devEnv);
    expect(res.status).toBe(101);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});

describe('pipelineCachePolicy: a handler opting itself in', () => {
  it('leaves the storable header standing when the stage is not mounted', async () => {
    const bare = new Hono<AppEnv>().get('/storable-handler', storableHandler);
    const res = await bare.request('/storable-handler', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=3600');
    expect(res.headers.get('Cache-Tag')).toBe('smuggled');
  });

  it('overrides the storable header a route declared no-store set for itself', async () => {
    const res = await buildApp().request('/storable-handler', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('overrides the storable header an undeclared route set for itself', async () => {
    const res = await buildApp().request('/unpoliced-storable', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('drops the purge tag a route it refuses storage of set for itself', async () => {
    const res = await buildApp().request('/unpoliced-storable', {}, devEnv);
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });
});

describe('pipelineCachePolicy: an unwired policy map', () => {
  it('leaves every response header untouched outside production', async () => {
    const res = await buildApp({}).request('/storable-handler', {}, devEnv);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=3600');
  });

  it('fails fast in production rather than serving a route no policy governs', async () => {
    const app = buildApp({}).onError((error, c) => c.json({ message: error.message }, 500));
    const res = await app.request('/storable-handler', {}, { ...devEnv, NODE_ENV: 'production' });
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/cache-policy/);
  });

  it('refuses storage of the defect it raises in production', async () => {
    const app = buildApp({}).onError((error, c) => c.json({ message: error.message }, 500));
    const res = await app.request('/storable-handler', {}, { ...devEnv, NODE_ENV: 'production' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('fails fast when applied without the env stage (pipeline order violated)', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineCachePolicy({ policies }))
      .get('/shared', routeClass('public'), (c) => c.json({ ok: true }))
      .onError((error, c) => c.json({ message: error.message }, 500));
    const res = await app.request('/shared', {}, devEnv);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipeline order/);
  });
});

const FRONTEND_URL = 'https://app.hushbox.ai';
const corsEnv: TestEnv = {
  ...devEnv,
  FRONTEND_URL,
  FRONTEND_PREVIEW_URL: 'https://preview.hushbox.ai',
  MARKETING_URL: 'https://marketing.hushbox.ai',
};
const STRANGER = { Origin: 'https://stranger.example' };

/**
 * The real mount order: cors ahead of the pipeline, so it is the outermost
 * middleware and unwinds LAST — reading the `Cache-Control` this stage wrote
 * rather than whatever a handler left behind.
 */
function buildCorsApp(options?: { readonly policies?: CachePolicyMap }): Hono<AppEnv> {
  const root = new Hono<AppEnv>().use('*', markPipelineHandler(cors()));
  return applyPipeline(root, {
    rateLimit: { postures },
    cache: options ?? { policies },
  })
    .get('/shared', routeClass('public'), (c) =>
      c.req.query('defect') === undefined ? c.json({ ok: true }) : c.json({ ok: false }, 500)
    )
    .get('/immutable', routeClass('public'), (c) => c.json({ ok: true }))
    .get('/shared-throttled', routeClass('public'), (c) => c.json({ ok: true }))
    .get('/unpoliced-storable', routeClass('public'), storableHandler);
}

describe('pipelineCachePolicy: what the CORS grant now reads', () => {
  it('grants the cross-origin wildcard on a route declared shared-cacheable', async () => {
    const res = await buildCorsApp().request('/shared', { headers: STRANGER }, corsEnv);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('withholds it from a route declared immutable, which names no s-maxage', async () => {
    const res = await buildCorsApp().request('/immutable', { headers: STRANGER }, corsEnv);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('grants it to an undeclared public route when the stage is not wired', async () => {
    const res = await buildCorsApp({}).request(
      '/unpoliced-storable',
      { headers: STRANGER },
      corsEnv
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('withholds it from an undeclared public route once the stage is wired', async () => {
    const res = await buildCorsApp().request('/unpoliced-storable', { headers: STRANGER }, corsEnv);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('withholds it from a declared-cacheable route answering a defect', async () => {
    const res = await buildCorsApp().request('/shared?defect', { headers: STRANGER }, corsEnv);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('withholds it from a declared-cacheable route the posture gate throttles', async () => {
    const res = await buildCorsApp().request('/shared-throttled', { headers: STRANGER }, corsEnv);
    expect(res.status).toBe(429);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

/**
 * Statuses a shared cache stores with no `Cache-Control` telling it to, on the
 * platform's documented heuristic. A response short-circuited ahead of the
 * pipeline carries whatever its own middleware set and nothing this stage
 * wrote, so this is the set that decides whether that gap matters.
 */
const HEURISTICALLY_CACHEABLE_STATUSES: ReadonlySet<number> = new Set([
  200, 203, 204, 300, 301, 404, 405, 410, 414, 501,
]);
/** A request shape, and the env that makes the ring answer it the way it does. */
interface RingRequest {
  readonly init: RequestInit;
  readonly env?: TestEnv;
}

/** The stale-client request `versionCheck` refuses, and the env that makes it stale. */
const STALE_CLIENT: RequestInit = { headers: { 'X-App-Version': '0.0.0-stale' } };
const STALE_CLIENT_ENV: TestEnv = { ...corsEnv, APP_VERSION: '9.9.9' };
/** A `Content-Length` past the cap, which `requestBodyLimit` refuses on the header alone. */
const OVERSIZED: HeadersInit = { 'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1) };

/**
 * The GET shapes: one per refusal any ring middleware is known to have — a
 * cross-origin read, an oversized declaration, a stale client — plus a request
 * carrying none of them. `GET` and `HEAD` are the only methods the platform
 * ever caches, so this is the set that can reach a cache at all.
 */
const RING_GET_REQUESTS: readonly RingRequest[] = [
  { init: {} },
  { init: { headers: STRANGER } },
  { init: { headers: OVERSIZED } },
  { init: STALE_CLIENT, env: STALE_CLIENT_ENV },
];

/** Those, plus the preflight and the mutating shapes the two mutation gates guard. */
const RING_REQUESTS: readonly RingRequest[] = [
  ...RING_GET_REQUESTS,
  { init: { method: 'OPTIONS', headers: STRANGER } },
  { init: { method: 'POST', headers: STRANGER } },
  { init: { method: 'POST', body: 'x'.repeat(64), headers: OVERSIZED } },
];

/**
 * Every status the ring answers with WITHOUT calling `next()`. Those are the
 * responses no pipeline stage ever sees, so they carry whatever their own
 * middleware set and nothing this stage wrote.
 *
 * The ring comes from {@link edgeRing}, the same sequence the app assembly
 * mounts, and every member is driven by every shape rather than by one
 * hand-paired request — so a middleware added to the ring is measured here
 * without anyone remembering to add it. Each member is mounted alone, so one
 * gaining a refusal fails this whether or not its neighbours moved; a probe
 * whose handler ran is a pass-through and reaches the pipeline normally, so it
 * is not recorded.
 */
async function shortCircuitStatuses(
  requests: readonly RingRequest[]
): Promise<ReadonlySet<number>> {
  const statuses = new Set<number>();
  for (const request of requests) {
    for (const middleware of edgeRing()) {
      const reached = { handler: false };
      const answer = (c: Context<AppEnv>): Response => {
        reached.handler = true;
        return c.json({ ok: true });
      };
      // Every method routed, so a 404 can only ever come from the ring
      // member under test rather than from an unregistered probe method.
      const app = new Hono<AppEnv>().use('*', middleware).all('/probe', answer);
      const res = await app.request('/probe', request.init, request.env ?? corsEnv);
      if (!reached.handler) statuses.add(res.status);
    }
  }
  return statuses;
}

function sorted(statuses: ReadonlySet<number>): readonly number[] {
  return [...statuses].toSorted((a, b) => a - b);
}

/**
 * The gap this stage does not close, measured rather than argued. Every
 * pipeline stage is mounted inside `applyPipeline`, and the edge ring is
 * mounted ahead of it, so a ring middleware that answers without calling
 * `next()` produces a response no stage ever writes a header onto.
 *
 * The gap is accepted, and what closes it is the platform rather than our own
 * code — the weaker of the two guarantees. The one status that ring can answer
 * with that a shared cache would store unbidden is the 204 of a CORS
 * preflight, and only `GET` and `HEAD` are ever cached, so no response the ring
 * can produce on a cacheable method is storable. The re-entry condition: if the
 * platform ever caches `OPTIONS`, a no-store default belongs ahead of `cors()`
 * in the app's mount order.
 *
 * These pins are what makes that conditional rather than permanent: a ring
 * middleware that starts answering a GET with a 200, a 301 or a 404 fails here
 * instead of silently becoming storable.
 */
describe('the ring ahead of the pipeline, which this stage cannot reach', () => {
  it('short-circuits with only these statuses', async () => {
    expect(sorted(await shortCircuitStatuses(RING_REQUESTS))).toEqual([204, 403, 413, 426]);
  });

  it('short-circuits a GET with only these statuses', async () => {
    expect(sorted(await shortCircuitStatuses(RING_GET_REQUESTS))).toEqual([426]);
  });

  it('answers a GET with no status a shared cache stores on its own heuristic', async () => {
    const storable = sorted(await shortCircuitStatuses(RING_GET_REQUESTS)).filter((status) =>
      HEURISTICALLY_CACHEABLE_STATUSES.has(status)
    );
    expect(storable).toEqual([]);
  });
});
