import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

vi.mock('@hushbox/db', () => ({
  createDb: vi.fn(() => ({ mocked: 'db' })),
  LOCAL_NEON_DEV_CONFIG: { mocked: 'config' },
}));

vi.mock('../services/email/index.js', () => ({
  getEmailClient: vi.fn(() => ({ type: 'email' })),
}));

vi.mock('../services/openrouter/index.js', () => ({
  getOpenRouterClient: vi.fn(() => ({ type: 'openrouter', isMock: false })),
}));

vi.mock('../services/helcim/index.js', () => ({
  getHelcimClient: vi.fn(() => ({ type: 'helcim', isMock: false })),
}));

function createMockRedisInstance(): Record<string, unknown> {
  const store = new Map<string, unknown>();
  return {
    mocked: 'redis',
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    _store: store,
  };
}

vi.mock('../lib/redis.js', () => ({
  createRedisClient: vi.fn(() => createMockRedisInstance()),
}));

vi.mock('iron-session', () => ({
  getIronSession: vi.fn(),
}));

import {
  dbMiddleware,
  redisMiddleware,
  sessionMiddleware,
  openRouterMiddleware,
  helcimMiddleware,
  envMiddleware,
  ironSessionMiddleware,
} from './dependencies.js';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import { getOpenRouterClient } from '../services/openrouter/index.js';
import { getHelcimClient } from '../services/helcim/index.js';
import { createRedisClient } from '../lib/redis.js';

describe('dbMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets db on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.get('/', (c) => {
      c.get('db');
      return c.json({ hasDb: true });
    });

    const res = await app.request(
      '/',
      {},
      { DATABASE_URL: 'postgres://test', NODE_ENV: 'production' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasDb: true });
  });

  it('uses LOCAL_NEON_DEV_CONFIG in development mode', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test', NODE_ENV: 'development' });

    expect(createDb).toHaveBeenCalledWith({
      connectionString: 'postgres://test',
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  it('omits neonDev config in production mode', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test', NODE_ENV: 'production' });

    expect(createDb).toHaveBeenCalledWith({
      connectionString: 'postgres://test',
    });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(nextCalled).toHaveBeenCalled();
  });
});

// OPAQUE-MIGRATION: authMiddleware tests removed - auth has been migrated to OPAQUE (Phase 9)

describe('sessionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns 401 when no session exists (OPAQUE auth gate)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      return c.json({ message: 'should not reach here' });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ code: 'NOT_AUTHENTICATED' });
  });

  it('returns 401 when session is not active in Redis', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', (c, next) => {
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      return c.json({ message: 'should not reach here' });
    });

    const res = await app.request(
      '/',
      {},
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when session predates password change', async () => {
    const app = new Hono<AppEnv>();
    const createdAt = Date.now() - 10_000;
    const passwordChangedAt = Date.now();

    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', async (c, next) => {
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'test-user-id', 'test-session-id');
      await redisSet(redis, 'passwordChangedAt', passwordChangedAt, 'test-user-id');
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt,
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      return c.json({ message: 'should not reach here' });
    });

    const res = await app.request(
      '/',
      {},
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(401);
  });
});

describe('openRouterMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets openrouter on context', async () => {
    const app = new Hono<AppEnv>();
    // openRouterMiddleware requires envUtils and db from previous middleware
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', openRouterMiddleware());
    app.get('/', (c) => {
      c.get('openrouter');
      return c.json({ hasOpenRouter: true });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasOpenRouter: true });
  });

  it('passes env and evidence config to getOpenRouterClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', openRouterMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = {
      OPENROUTER_API_KEY: 'test-key',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://test',
    };
    await app.request('/', {}, env);

    expect(getOpenRouterClient).toHaveBeenCalledWith(env, expect.any(Object));
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', openRouterMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('helcimMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets helcim on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', helcimMiddleware());
    app.get('/', (c) => {
      c.get('helcim');
      return c.json({ hasHelcim: true });
    });

    const res = await app.request('/', {}, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasHelcim: true });
  });

  it('passes env to getHelcimClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', helcimMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = {
      HELCIM_API_TOKEN: 'test-token',
      HELCIM_WEBHOOK_VERIFIER: 'test-verifier',
      NODE_ENV: 'production',
    };
    await app.request('/', {}, env);

    expect(getHelcimClient).toHaveBeenCalledWith(env);
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', helcimMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, {});

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('envMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets envUtils on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      c.get('envUtils'); // Verify it's set
      return c.json({ hasEnvUtils: true });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasEnvUtils: true });
  });

  it('returns correct isDev flag for development', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isDev, isLocalDev, isProduction } = c.get('envUtils');
      return c.json({ isDev, isLocalDev, isProduction });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development' });
    const body = await res.json();
    expect(body).toEqual({ isDev: true, isLocalDev: true, isProduction: false });
  });

  it('returns correct isCI flag when CI is set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isCI, isLocalDev, requiresRealServices } = c.get('envUtils');
      return c.json({ isCI, isLocalDev, requiresRealServices });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development', CI: 'true' });
    const body = await res.json();
    expect(body).toEqual({ isCI: true, isLocalDev: false, requiresRealServices: true });
  });

  it('returns correct isProduction flag for production', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isDev, isProduction, requiresRealServices } = c.get('envUtils');
      return c.json({ isDev, isProduction, requiresRealServices });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'production' });
    const body = await res.json();
    expect(body).toEqual({ isDev: false, isProduction: true, requiresRealServices: true });
  });

  it('returns correct isE2E flag when E2E is set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isCI, isE2E } = c.get('envUtils');
      return c.json({ isCI, isE2E });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development', CI: 'true', E2E: 'true' });
    const body = await res.json();
    expect(body).toEqual({ isCI: true, isE2E: true });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', envMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { NODE_ENV: 'development' });

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('redisMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets redis on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', redisMiddleware());
    app.get('/', (c) => {
      c.get('redis');
      return c.json({ hasRedis: true });
    });

    const res = await app.request(
      '/',
      {},
      { UPSTASH_REDIS_REST_URL: 'http://localhost:8079', UPSTASH_REDIS_REST_TOKEN: 'test-token' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasRedis: true });
  });

  it('passes env config to createRedisClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', redisMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = {
      UPSTASH_REDIS_REST_URL: 'https://redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'prod-token',
    };
    await app.request('/', {}, env);

    expect(createRedisClient).toHaveBeenCalledWith('https://redis.upstash.io', 'prod-token');
  });

  it('throws when UPSTASH_REDIS_REST_URL is missing', async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.json({ error: (err as Error).message }, 500));
    app.use('*', redisMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const res = await app.request('/', {}, { UPSTASH_REDIS_REST_TOKEN: 'test-token' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required',
    });
  });

  it('throws when UPSTASH_REDIS_REST_TOKEN is missing', async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.json({ error: (err as Error).message }, 500));
    app.use('*', redisMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const res = await app.request('/', {}, { UPSTASH_REDIS_REST_URL: 'http://localhost:8079' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required',
    });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', redisMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request(
      '/',
      {},
      { UPSTASH_REDIS_REST_URL: 'http://localhost:8079', UPSTASH_REDIS_REST_TOKEN: 'test-token' }
    );

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('ironSessionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns a middleware function', () => {
    const middleware = ironSessionMiddleware();

    expect(middleware).toBeDefined();
    expect(typeof middleware).toBe('function');
  });

  it('sets sessionData to null when no IRON_SESSION_SECRET', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', ironSessionMiddleware());
    app.get('/', (c) => {
      const sessionData = c.get('sessionData');
      return c.json({ sessionData });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ sessionData: unknown }>(res);
    expect(body.sessionData).toBeNull();
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', ironSessionMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(nextCalled).toHaveBeenCalled();
  });
});
