/**
 * The response shapes the node-environment project cannot construct, or cannot
 * construct honestly: a `101` carrying a live socket (undici refuses any status
 * below 200), a body that is a stream still being written rather than bytes
 * already in hand, and an answer that came back across a real service boundary,
 * whose headers workerd marks immutable. Each has a real route behind it — the
 * realtime and trial upgrades proxy a Durable Object's answer, and the OTA
 * bundle route returns an R2 object's stream — and the stage writes headers on
 * `c.res` after `next()`, so what it does to them is a runtime question about
 * the response object, answerable only inside workerd.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { env as workerEnv } from 'cloudflare:workers';
import { applyPipeline } from './pipeline.js';
import { pipelineCachePolicy } from './pipeline-cache-policy.js';
import { pipelineEnv } from './pipeline-env.js';
import { routeClass } from './pipeline-markers.js';
import { bindRoutePosture } from '../lib/rate-limit/index.js';
import { WORKERS_PIPELINE_BINDINGS } from '../test-support/workers-pipeline-bindings.js';
import type { CachePolicyMap } from './pipeline-cache-policy.js';
import type { RoutePostureMap } from './pipeline-rate-limit.js';
import type { AppEnv } from '../lib/context/index.js';
import type { ThrottleLimit } from '../lib/rate-limit/index.js';

const BUNDLE_BYTES = 'bundle-bytes';
const FIRST_CHUNK = 'first-chunk';
const LATER_CHUNK = 'later-chunk';

/**
 * How long a response may take to be handed back before the test calls it
 * hung. A stage that buffered the body would never hand back a response whose
 * stream is still open, so this bound is what turns that hang into a failure
 * with a name.
 */
const RESPONSE_BOUND_MS = 2000;

/** The far side of a real service boundary; see the workers vitest config. */
interface CrossBoundaryEnv {
  readonly CROSS_BOUNDARY_RESPONDER: { readonly fetch: (input: Request) => Promise<Response> };
}

const policies: CachePolicyMap = {
  '$get /realtime': { kind: 'no-store' },
  '$get /bundle': { kind: 'immutable', maxAgeSeconds: 86_400, tag: 'fixture-bundle' },
  '$get /open-bundle': { kind: 'immutable', maxAgeSeconds: 86_400, tag: 'fixture-bundle' },
  '$get /refusal': { kind: 'no-store' },
};

/**
 * The fixture routes' bound, declared as counted IN FLOW so the posture stage
 * spends nothing: what these tests observe is the cache stage's treatment of a
 * response, and the Redis this file's bindings name is a placeholder that
 * answers nothing. A `default` here would send each request through its route
 * class's default and into that placeholder.
 */
const inFlowOnly = {
  kind: 'throttle',
  maxAttempts: 4,
  windowSeconds: 60,
  buildKey: (id: string) => `cache-policy-fixture:in-flow:${id}`,
} as const satisfies ThrottleLimit;

const boundInFlow = bindRoutePosture({
  failure: 'closed',
  layers: [{ identity: 'ip', countedAt: 'flow', definition: inFlowOnly }],
});

const postures: RoutePostureMap = {
  '$get /realtime': boundInFlow,
  '$get /bundle': boundInFlow,
  '$get /open-bundle': boundInFlow,
  '$get /refusal': boundInFlow,
};

/** The responder's answer, unread and unrebuilt, exactly as `fetch` produced it. */
async function crossBoundaryRefusal(): Promise<Response> {
  return await (workerEnv as unknown as CrossBoundaryEnv).CROSS_BOUNDARY_RESPONDER.fetch(
    new Request('https://responder.invalid/refusal')
  );
}

/**
 * Resolves only if the response is handed back before the bound; a hang
 * becomes a named failure rather than a suite timeout.
 */
async function withinBound(pending: Response | Promise<Response>): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('the response was not handed back while its body stream was open'));
    }, RESPONSE_BOUND_MS);
  });
  try {
    return await Promise.race([pending, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A body whose stream stays OPEN until the test closes it, plus the handle the
 * test writes to. This is what separates "the header write did not buffer the
 * body" from "the header write did not disturb it": a stage that read the body
 * to rebuild the response would still deliver every byte of a stream that had
 * already closed, but it can never hand back a response while the stream is
 * still open.
 */
function openStreamRoute(): {
  readonly app: Hono<AppEnv>;
  readonly enqueue: (text: string) => void;
  readonly close: () => void;
} {
  let handle: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      handle = controller;
      controller.enqueue(encoder.encode(FIRST_CHUNK));
    },
  });
  const app = applyPipeline(new Hono<AppEnv>(), {
    rateLimit: { postures },
    cache: { policies },
  }).get('/open-bundle', routeClass('public'), () => new Response(body, { status: 200 }));
  return {
    app,
    enqueue: (text: string): void => {
      handle?.enqueue(encoder.encode(text));
    },
    close: (): void => {
      handle?.close();
    },
  };
}

function buildApp(): Hono<AppEnv> {
  return applyPipeline(new Hono<AppEnv>(), {
    rateLimit: { postures },
    cache: { policies },
  })
    .get('/realtime', routeClass('public'), () => {
      const pair = new WebSocketPair();
      return new Response(null, { status: 101, webSocket: pair[0] });
    })
    .get('/refusal', routeClass('public'), async () => await crossBoundaryRefusal())
    .get('/bundle', routeClass('public'), () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(BUNDLE_BYTES));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    });
}

describe('pipelineCachePolicy under the runtime the Worker actually runs on', () => {
  it('runs on workerd, not on the node test runtime', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
});

describe('pipelineCachePolicy: a WebSocket upgrade', () => {
  it('writes no cache directives onto the upgrade response', async () => {
    const res = await buildApp().request('/realtime', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('hands back the upgrade with its socket still attached', async () => {
    const res = await buildApp().request('/realtime', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
  });
});

describe('pipelineCachePolicy: a streamed body', () => {
  it('emits the directives its policy declares', async () => {
    const res = await buildApp().request('/bundle', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
  });

  it('leaves the body unread by the header write', async () => {
    const res = await buildApp().request('/bundle', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.bodyUsed).toBe(false);
  });

  it('delivers every byte of the stream to the caller', async () => {
    const res = await buildApp().request('/bundle', {}, WORKERS_PIPELINE_BINDINGS);
    const delivered = new TextDecoder().decode(await res.arrayBuffer());
    expect(delivered).toBe(BUNDLE_BYTES);
  });
});

describe('pipelineCachePolicy: a body stream still being written', () => {
  it('hands back the response while the stream is still open', async () => {
    const route = openStreamRoute();
    const res = await withinBound(route.app.request('/open-bundle', {}, WORKERS_PIPELINE_BINDINGS));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
    route.close();
  });

  it('delivers bytes enqueued after the response was handed back', async () => {
    const route = openStreamRoute();
    const res = await withinBound(route.app.request('/open-bundle', {}, WORKERS_PIPELINE_BINDINGS));
    const reader = (res.body ?? new ReadableStream<Uint8Array>()).getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(FIRST_CHUNK);
    route.enqueue(LATER_CHUNK);
    const later = await reader.read();
    expect(decoder.decode(later.value)).toBe(LATER_CHUNK);
    route.close();
  });
});

/**
 * The coupling this stage rests on, made a test rather than a comment. A
 * response that came back across a service boundary has immutable headers, so
 * writing to one throws; nothing reaches this stage holding one because
 * the session stage reads `c.res` before calling `next()`, and hono
 * replaces an already-materialized `c.res` with a fresh mutable response when
 * the handler's own is assigned. Remove or reorder that read and
 * `refuses storage of the responder's answer through the assembled pipeline`
 * fails, which is the point of it.
 *
 * The route is not hypothetical: the realtime upgrade proxies a Durable
 * Object's answer whatever its status, so a room declining an upgrade rides
 * exactly this path.
 */
describe('pipelineCachePolicy: an answer from across a service boundary', () => {
  it("refuses storage of the responder's answer through the assembled pipeline", async () => {
    const res = await buildApp().request('/refusal', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("hands back the responder's own status", async () => {
    const res = await buildApp().request('/refusal', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.status).toBe(403);
  });

  it('answers a defect without the stage ahead of it that rebuilds the response', async () => {
    const alone = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineCachePolicy({ policies }))
      .get('/refusal', routeClass('public'), async () => await crossBoundaryRefusal())
      .onError((error, c) => c.json({ message: error.message }, 500));
    const res = await alone.request('/refusal', {}, WORKERS_PIPELINE_BINDINGS);
    expect(res.status).toBe(500);
  });
});
