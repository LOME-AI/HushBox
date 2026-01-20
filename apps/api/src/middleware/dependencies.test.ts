import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

vi.mock('@lome-chat/db', () => ({
  createDb: vi.fn(() => ({ mocked: 'db' })),
  LOCAL_NEON_DEV_CONFIG: { mocked: 'config' },
}));

vi.mock('../auth/index.js', () => ({
  createAuth: vi.fn(() => ({
    mocked: 'auth',
    api: {
      getSession: vi.fn(),
    },
  })),
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

import {
  dbMiddleware,
  authMiddleware,
  sessionMiddleware,
  openRouterMiddleware,
  helcimMiddleware,
  envMiddleware,
} from './dependencies.js';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@lome-chat/db';
import { createAuth } from '../auth/index.js';
import { getEmailClient } from '../services/email/index.js';
import { getOpenRouterClient } from '../services/openrouter/index.js';
import { getHelcimClient } from '../services/helcim/index.js';

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

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets auth on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.get('/', (c) => {
      c.get('auth');
      return c.json({ hasAuth: true });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasAuth: true });
  });

  it('passes env to getEmailClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = {
      DATABASE_URL: 'postgres://test',
      RESEND_API_KEY: 'test-key',
      NODE_ENV: 'production',
    };
    await app.request('/', {}, env);

    expect(getEmailClient).toHaveBeenCalledWith(env);
  });

  it('uses default auth URL when BETTER_AUTH_URL not set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(createAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://localhost:8787',
      })
    );
  });

  it('uses custom auth URL when BETTER_AUTH_URL is set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request(
      '/',
      {},
      { DATABASE_URL: 'postgres://test', BETTER_AUTH_URL: 'https://api.example.com' }
    );

    expect(createAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://api.example.com',
      })
    );
  });

  it('uses default secret when BETTER_AUTH_SECRET not set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(createAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: 'dev-secret-minimum-32-characters-long',
      })
    );
  });
});

describe('sessionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets user and session on context when authenticated', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com', name: 'Test User' };
    const mockSession = { id: 'session-1', userId: 'user-1', expiresAt: new Date() };

    vi.mocked(createAuth).mockReturnValue({
      mocked: 'auth',
      api: {
        getSession: vi.fn().mockResolvedValue({ user: mockUser, session: mockSession }),
      },
    } as unknown as ReturnType<typeof createAuth>);

    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      const session = c.get('session');
      return c.json({ userId: user?.id, sessionId: session?.id });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ userId: 'user-1', sessionId: 'session-1' });
  });

  it('sets user and session to null when not authenticated', async () => {
    vi.mocked(createAuth).mockReturnValue({
      mocked: 'auth',
      api: {
        getSession: vi.fn().mockResolvedValue(null),
      },
    } as unknown as ReturnType<typeof createAuth>);

    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      const session = c.get('session');
      return c.json({ user, session });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ user: null, session: null });
  });

  it('passes request headers to getSession', async () => {
    const mockGetSession = vi.fn().mockResolvedValue(null);
    vi.mocked(createAuth).mockReturnValue({
      mocked: 'auth',
      api: {
        getSession: mockGetSession,
      },
    } as unknown as ReturnType<typeof createAuth>);

    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', authMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request(
      '/',
      { headers: { Cookie: 'session=abc123' } },
      { DATABASE_URL: 'postgres://test' }
    );

    expect(mockGetSession).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.any(Headers) as object,
      })
    );
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
    app.use('*', openRouterMiddleware());
    app.get('/', (c) => {
      c.get('openrouter');
      return c.json({ hasOpenRouter: true });
    });

    const res = await app.request('/', {}, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasOpenRouter: true });
  });

  it('passes env to getOpenRouterClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', openRouterMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = { OPENROUTER_API_KEY: 'test-key', NODE_ENV: 'production' };
    await app.request('/', {}, env);

    expect(getOpenRouterClient).toHaveBeenCalledWith(env);
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', openRouterMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, {});

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
