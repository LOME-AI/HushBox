import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { hmacSha256Hex } from '@hushbox/crypto';
import { pipelineEnv } from './pipeline-env.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { isPipelineHandler } from './pipeline-markers.js';
import { FINGERPRINT_CODES, createRequestTelemetry } from '../lib/telemetry/index.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { Telemetry, TelemetryEnv } from '../lib/telemetry/index.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json();
}

const completeEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

function createProbeApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', pipelineEnv())
    .use('*', pipelineBindings())
    .get('/probe', (c) =>
      c.json({
        hasDb: typeof c.get('db').select === 'function',
        hasRedis: typeof c.get('redis').get === 'function',
        hasLogger: typeof c.get('logger').info === 'function',
        bindings: c.get('bindings'),
      })
    )
    .onError((err, c) => c.json({ message: err.message }, 500));
}

describe('pipelineBindings', () => {
  it('populates db, redis, logger, and the validated bindings on the context', async () => {
    const res = await createProbeApp().request('/probe', {}, completeEnv);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      hasDb: boolean;
      hasRedis: boolean;
      hasLogger: boolean;
      bindings: Record<string, string>;
    }>(res);
    expect(body.hasDb).toBe(true);
    expect(body.hasRedis).toBe(true);
    expect(body.hasLogger).toBe(true);
    expect(body.bindings['IRON_SESSION_SECRET']).toBe(completeEnv.IRON_SESSION_SECRET);
  });

  it('binds the console telemetry adapter as the logger', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {
      // Silenced: the assertion is on the structured line, not the output.
    });
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        c.get('logger').info('pipeline probe', { requestId: 'r-1' });
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', msg: 'pipeline probe', requestId: 'r-1' })
    );
    spy.mockRestore();
  });

  it('fails fast naming TELEMETRY_SINKS when the sink list is missing', async () => {
    const incomplete = { ...completeEnv };
    delete incomplete.TELEMETRY_SINKS;
    const res = await createProbeApp().request('/probe', {}, incomplete);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toContain('TELEMETRY_SINKS');
  });

  it('fails fast naming the missing binding', async () => {
    const incomplete = { ...completeEnv };
    delete incomplete.DATABASE_URL;
    const res = await createProbeApp().request('/probe', {}, incomplete);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toContain('DATABASE_URL');
  });

  it('fails fast when applied without the env stage (pipeline order violated)', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineBindings())
      .get('/probe', (c) => c.json({ ok: true }))
      .onError((err, c) => c.json({ message: err.message }, 500));
    const res = await app.request('/probe', {}, completeEnv);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipeline order/);
  });

  it('is marked as a pipeline handler', () => {
    expect(isPipelineHandler(pipelineBindings())).toBe(true);
  });
});

/**
 * The bound is write-once per module graph and the test runner's setup file has
 * already settled it for this process, so observing the stage settle one takes
 * a fresh module registry — which is also what makes the absent-entry case
 * reachable at all.
 */
async function freshBoundProbe(env: Bindings & TelemetryEnv): Promise<Response> {
  vi.resetModules();
  const { pipelineEnv: freshEnvStage } = await import('./pipeline-env.js');
  const { pipelineBindings: freshBindingsStage } = await import('./pipeline-bindings.js');
  const app = new Hono<AppEnv>()
    .use('*', freshEnvStage())
    .use('*', freshBindingsStage())
    .get('/probe', (c) => c.json({ ok: true }))
    .onError((err, c) => c.json({ message: err.message }, 500));
  return await app.request('/probe', {}, env);
}

describe('pipelineBindings rate-limit bound', () => {
  it('puts the isolate bound in force from the registry entry', async () => {
    const res = await freshBoundProbe({
      ...completeEnv,
      RATE_LIMIT_REDIS_TIMEOUT_MS: '77',
      RATE_LIMIT_KEY_SECRET: 'probe-key',
    });
    const { rateLimitBound } = await import('../lib/rate-limit/index.js');

    expect(res.status).toBe(200);
    expect(rateLimitBound().timeoutMs).toBe(77);
  });

  it('fails fast naming the entry when the bound is not declared', async () => {
    const res = await freshBoundProbe(completeEnv);

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/RATE_LIMIT_REDIS_TIMEOUT_MS/);
  });
});

describe('pipelineBindings rate-limit identifier key', () => {
  it('puts the isolate identifier key in force from the registry entry', async () => {
    const res = await freshBoundProbe({
      ...completeEnv,
      RATE_LIMIT_REDIS_TIMEOUT_MS: '77',
      RATE_LIMIT_KEY_SECRET: 'probe-key',
    });
    const { hmacRateLimitId } = await import('../lib/rate-limit/index.js');

    expect(res.status).toBe(200);
    expect(hmacRateLimitId('carol@hushbox.ai')).toBe(
      hmacSha256Hex('probe-key', 'carol@hushbox.ai')
    );
  });

  it('fails fast naming the entry when the key is not declared', async () => {
    const res = await freshBoundProbe({ ...completeEnv, RATE_LIMIT_REDIS_TIMEOUT_MS: '77' });

    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/RATE_LIMIT_KEY_SECRET/);
  });
});

describe('pipelineBindings request-db teardown', () => {
  it('registers the per-request Neon pool close on executionCtx.waitUntil after the response', async () => {
    const tasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (task: Promise<unknown>): void => {
        tasks.push(task);
      },
      passThroughOnException: (): void => {
        // Unused here; present to satisfy the ExecutionContext shape.
      },
      props: {},
    };
    const endCalls = { count: 0 };
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          endCalls.count += 1;
        });
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv, executionCtx);

    // Response is intact (not closed mid-use) and the pool close is registered
    // on waitUntil exactly once — never blocking the response, never double-closed.
    expect(res.status).toBe(200);
    expect(await jsonBody<{ ok: boolean }>(res)).toEqual({ ok: true });
    expect(endCalls.count).toBe(1);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
  });

  it('closes the per-request Neon pool inline when no ExecutionContext exists', async () => {
    const endCalls = { count: 0 };
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          endCalls.count += 1;
        });
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv);

    expect(res.status).toBe(200);
    expect(await jsonBody<{ ok: boolean }>(res)).toEqual({ ok: true });
    expect(endCalls.count).toBe(1);
  });

  it('closes the per-request Neon pool even when a downstream handler throws', async () => {
    const endCalls = { count: 0 };
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          endCalls.count += 1;
        });
        throw new Error('downstream boom');
      })
      .onError((err, c) => c.json({ message: err.message }, 500));

    const res = await app.request('/probe', {}, completeEnv);

    expect(res.status).toBe(500);
    expect(endCalls.count).toBe(1);
  });
});

describe('pipelineBindings side-band registration', () => {
  /** A collecting ExecutionContext, so post-response work is inspectable. */
  function createCollectingExecutionCtx(tasks: Promise<unknown>[]): ExecutionContext {
    return {
      waitUntil: (task: Promise<unknown>): void => {
        tasks.push(task);
      },
      passThroughOnException: (): void => {
        // Unused here; present to satisfy the ExecutionContext shape.
      },
      props: {},
    };
  }

  it('holds the request pool open until a registered side-band task settles', async () => {
    const tasks: Promise<unknown>[] = [];
    const order: string[] = [];
    let releaseSideBand = (): void => {
      throw new Error('gate not installed');
    };
    const gate = new Promise<void>((resolve) => {
      releaseSideBand = resolve;
    });
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          order.push('pool-closed');
        });
        c.var.sideBand(
          (async () => {
            await gate;
            order.push('side-band-settled');
          })()
        );
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv, createCollectingExecutionCtx(tasks));

    expect(res.status).toBe(200);
    // The response is out and the teardown is scheduled, but the pool must
    // still be usable while the side-band holds it.
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseSideBand();
    await Promise.all(tasks);
    expect(order).toEqual(['side-band-settled', 'pool-closed']);
  });

  it('closes the request pool when a registered side-band task rejects', async () => {
    const tasks: Promise<unknown>[] = [];
    const endCalls = { count: 0 };
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          endCalls.count += 1;
        });
        c.var.sideBand(Promise.reject(new Error('side-band boom')));
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv, createCollectingExecutionCtx(tasks));

    expect(res.status).toBe(200);
    await Promise.all(tasks);
    expect(endCalls.count).toBe(1);
  });

  it('settles a side-band task registered by another side-band task', async () => {
    const tasks: Promise<unknown>[] = [];
    const order: string[] = [];
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          order.push('pool-closed');
        });
        c.var.sideBand(
          (async () => {
            // Yields first, so the task is genuinely unsettled at handler return.
            await Promise.resolve();
            order.push('outer-settled');
            c.var.sideBand(
              (async () => {
                await Promise.resolve();
                order.push('nested-settled');
              })()
            );
          })()
        );
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv, createCollectingExecutionCtx(tasks));

    expect(res.status).toBe(200);
    await Promise.all(tasks);
    expect(order).toEqual(['outer-settled', 'nested-settled', 'pool-closed']);
  });

  it('settles registered side-band work inline where no ExecutionContext exists', async () => {
    const order: string[] = [];
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        vi.spyOn(c.get('db').$client, 'end').mockImplementation(() => {
          order.push('pool-closed');
        });
        c.var.sideBand(
          (async () => {
            await Promise.resolve();
            order.push('side-band-settled');
          })()
        );
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv);

    expect(res.status).toBe(200);
    expect(order).toEqual(['side-band-settled', 'pool-closed']);
  });
});

describe('pipelineBindings Sentry flush seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rides a captured defect onto executionCtx.waitUntil', async () => {
    // The fetch transport is the external seam; stubbed so no envelope leaves
    // the process.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          status: 200,
          headers: { get: (): null => null },
          text: () => Promise.resolve(''),
        })
      )
    );
    const sentryEnv: Bindings & TelemetryEnv = {
      ...completeEnv,
      TELEMETRY_SINKS: 'console,sentry',
      SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42',
    };
    const tasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (task: Promise<unknown>): void => {
        tasks.push(task);
      },
      passThroughOnException: (): void => {
        // Unused by the pipeline; present to satisfy the ExecutionContext shape.
      },
      props: {},
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Silenced: the assertion is on waitUntil, not the console channel.
    });
    try {
      const app = new Hono<AppEnv>()
        .use('*', pipelineEnv())
        .use('*', pipelineBindings())
        .get('/probe', (c) => {
          c.get('logger').captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
          return c.json({ ok: true });
        });

      const res = await app.request('/probe', {}, sentryEnv, executionCtx);

      expect(res.status).toBe(200);
      // Two waitUntil tasks: the captured-defect Sentry flush scheduled during
      // the handler, plus the per-request Neon pool close registered in the
      // bindings teardown. A probe WITHOUT captureError registers only the pool
      // close (one task), so the extra task here proves the defect rode onto
      // waitUntil.
      expect(tasks).toHaveLength(2);
      await Promise.all(tasks);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

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

describe('pipelineBindings request-context retention', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The production sink list, and the load-bearing part of these two tests: the
   * Sentry sink is what holds the flush scheduler, so a `console`-only
   * composition never builds the edge they are about. Measured — under
   * `'console'` the first test passes against a stage whose scheduler does
   * capture the context.
   */
  const sentryEnv: Bindings & TelemetryEnv = {
    ...completeEnv,
    TELEMETRY_SINKS: 'console,sentry',
    SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42',
  };

  it('leaves the request context collectable while the request logger is still held', async () => {
    // Holding the logger is what makes this the Worker's situation rather than
    // a weaker one: there the logger sits in the request's AsyncLocalStorage
    // store, which workerd's `Response` pins through the frame it captured at
    // construction. Everything the logger can reach is therefore retained for
    // the isolate's life, and the Hono `Context` — which holds `c.res` — must
    // not be among it, or the cycle closes and the request never goes away.
    const anchor: { logger?: Telemetry } = {};
    let contextReference: WeakRef<object> | undefined;
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        anchor.logger = c.get('logger');
        contextReference = new WeakRef(c);
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, sentryEnv);

    expect(res.status).toBe(200);
    const reference = contextReference;
    if (reference === undefined) throw new Error('the probe handler did not run');
    expect(await isCollected(reference)).toBe(true);
    // Anchored on an object and read after the check: V8 may reclaim a local
    // nothing reads again, and this is what makes the logger unambiguously live
    // across the collection above.
    expect(anchor.logger).toBeDefined();
  });

  it('reports a context something still references as uncollected', async () => {
    // The same measurement with the answer known, so a pass above is a
    // property of the middleware rather than of a probe that can only say yes.
    const anchor: { context?: unknown } = {};
    let contextReference: WeakRef<object> | undefined;
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        anchor.context = c;
        contextReference = new WeakRef(c);
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, sentryEnv);

    expect(res.status).toBe(200);
    const reference = contextReference;
    if (reference === undefined) throw new Error('the probe handler did not run');
    expect(await isCollected(reference)).toBe(false);
    expect(anchor.context).toBeDefined();
  });

  /**
   * Composes telemetry the way the stage composes it, with a scheduler that
   * closes over a sentinel and nothing else. The sentinel lives in this
   * function's scope alone, so the only thing that can keep it alive is the
   * scheduler closure being held by the composed sinks.
   */
  function composeHoldingSentinel(): { telemetry: Telemetry; sentinel: WeakRef<object> } {
    const sentinel = { scheduled: 0 };
    const telemetry = createRequestTelemetry(sentryEnv, {
      scheduleFlush: () => {
        sentinel.scheduled += 1;
      },
    });
    return { telemetry, sentinel: new WeakRef(sentinel) };
  }

  it('composes a sink that holds the flush scheduler for as long as the telemetry is held', async () => {
    // The edge the first test measures ACROSS: a held logger reaches the Sentry
    // sink, which reaches the scheduler closure, which reaches whatever that
    // closure captured. Sever it and the first test still passes while measuring
    // nothing, because a context no closure can reach is trivially collectable.
    // Pinned here so that severing is a red build instead of a silent one —
    // swapping `sentryEnv` above for the console-only `completeEnv` drops the
    // scheduler and this case fails.
    const anchor: { logger?: Telemetry } = {};
    const { telemetry, sentinel } = composeHoldingSentinel();
    anchor.logger = telemetry;

    expect(await isCollected(sentinel)).toBe(false);
    expect(anchor.logger).toBeDefined();
  });
});
