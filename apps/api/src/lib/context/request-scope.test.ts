import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { createJobWakeCollector, grantJobWakes } from '../jobs/index.js';
import { createRequestDb, createRequestRedis } from './factories.js';
import {
  bindRequestValue,
  requestDb,
  requestEnv,
  requestLogger,
  requestPrincipal,
  requestRedis,
  requestScope,
} from './request-scope.js';
import type { Context } from 'hono';
import type { AppEnv, Bindings, RequiredBindings } from './app-env.js';
import type { Principal } from './principal.js';
import type { Telemetry } from '../telemetry/index.js';

/**
 * Placeholder infrastructure: nothing here opens a connection, because the
 * scope only stores what it is handed and reads it back. The pool is closed
 * after the file so an unused one is not left open.
 */
const BINDINGS: RequiredBindings = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
};

const ENV: Bindings = { NODE_ENV: 'development', ...BINDINGS };

const db = grantJobWakes(createRequestDb(BINDINGS, { isDev: true }), createJobWakeCollector());
const redis = createRequestRedis(BINDINGS);
const principal: Principal = { kind: 'none' };
const logger: Telemetry = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  captureError: () => undefined,
};

afterAll(async () => {
  await db.$client.end();
});

/** Runs `inside` within one request that entered the scope, and hands back its value. */
async function withinRequest<T>(inside: (c: Context<AppEnv>) => T): Promise<T> {
  let captured: { value: T } | undefined;
  const app = new Hono<AppEnv>();
  app.use(requestScope());
  app.get('/probe', (c) => {
    captured = { value: inside(c) };
    return c.json({ ok: true });
  });
  await app.request('/probe', {}, ENV);
  if (captured === undefined) throw new Error('the probe route did not run');
  return captured.value;
}

/** The message of whatever `read` threw, or nothing when it returned. */
function messageFromThrow(read: () => unknown): string | undefined {
  try {
    read();
    return undefined;
    // eslint-disable-next-line catch-swallow/no-silent-catch -- the throw IS the assertion here: it is turned into the value under test, not discarded
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the request scope outside a request', () => {
  it('refuses to answer for the bindings', () => {
    expect(() => requestEnv()).toThrow(/no request is in scope/);
  });

  it('refuses to answer for the database', () => {
    expect(() => requestDb()).toThrow(/no request is in scope/);
  });
});

describe('the request scope for a value no stage bound', () => {
  it('names the database', async () => {
    const message = await withinRequest(() => messageFromThrow(() => requestDb()));
    expect(message).toMatch(/db is not bound/);
  });

  it('names the redis client', async () => {
    const message = await withinRequest(() => messageFromThrow(() => requestRedis()));
    expect(message).toMatch(/redis is not bound/);
  });

  it('names the logger', async () => {
    const message = await withinRequest(() => messageFromThrow(() => requestLogger()));
    expect(message).toMatch(/logger is not bound/);
  });

  it('names the principal', async () => {
    const message = await withinRequest(() => messageFromThrow(() => requestPrincipal()));
    expect(message).toMatch(/principal is not bound/);
  });
});

describe('what a request scope carries', () => {
  it('carries the request bindings', async () => {
    expect(await withinRequest(() => requestEnv())).toEqual(ENV);
  });

  it('carries the database the stage bound', async () => {
    const seen = await withinRequest((c) => {
      bindRequestValue(c, 'db', db);
      return requestDb();
    });
    expect(seen).toBe(db);
  });

  it('carries the redis client the stage bound', async () => {
    const seen = await withinRequest((c) => {
      bindRequestValue(c, 'redis', redis);
      return requestRedis();
    });
    expect(seen).toBe(redis);
  });

  it('carries the logger the stage bound', async () => {
    const seen = await withinRequest((c) => {
      bindRequestValue(c, 'logger', logger);
      return requestLogger();
    });
    expect(seen).toBe(logger);
  });

  it('carries the principal the stage bound', async () => {
    const seen = await withinRequest((c) => {
      bindRequestValue(c, 'principal', principal);
      return requestPrincipal();
    });
    expect(seen).toBe(principal);
  });
});

describe('binding a request value writes both surfaces', () => {
  it('puts the value on c.var as well as in the scope', async () => {
    const seen = await withinRequest((c) => {
      bindRequestValue(c, 'redis', redis);
      return c.var.redis;
    });
    expect(seen).toBe(redis);
  });

  it('writes c.var even where no scope was entered', async () => {
    const app = new Hono<AppEnv>().get('/probe', (c) => {
      bindRequestValue(c, 'logger', logger);
      return c.json({ same: c.var.logger === logger });
    });
    const response = await app.request('/probe', {}, ENV);
    const body: unknown = await response.json();
    expect(body).toEqual({ same: true });
  });
});

describe('one scope per request', () => {
  it('starts the next request with nothing bound', async () => {
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.get('/bind', (c) => {
      bindRequestValue(c, 'redis', redis);
      return c.json({ ok: true });
    });
    app.get('/read', (c) =>
      c.json({ bound: messageFromThrow(() => requestRedis()) === undefined })
    );
    await app.request('/bind', {}, ENV);
    const response = await app.request('/read', {}, ENV);
    const body: unknown = await response.json();
    expect(body).toEqual({ bound: false });
  });
});
