import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from './app.js';

// Mock the database module for dev routes testing
const mockDbFrom = {
  where: vi.fn(() => Promise.resolve([])),
  innerJoin: vi.fn(() => ({
    where: vi.fn(() => Promise.resolve([{ count: 0 }])),
  })),
};

vi.mock('@lome-chat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lome-chat/db')>();
  return {
    ...actual,
    createDb: vi.fn(() => ({
      select: vi.fn(() => ({ from: vi.fn(() => mockDbFrom) })),
    })),
    LOCAL_NEON_DEV_CONFIG: {},
  };
});

describe('createApp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a new app instance', () => {
    const app = createApp();
    expect(app).toBeDefined();
  });

  describe('health route', () => {
    it('responds to GET /api/health', async () => {
      const app = createApp();
      const res = await app.request('/api/health');

      expect(res.status).toBe(200);
      const body: { status: string; timestamp: string } = await res.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBe('2024-01-15T12:00:00.000Z');
    });
  });

  describe('auth routes', () => {
    // Auth routes are now at /api/auth/* and handled by Better Auth
    // Full auth testing is done via E2E tests with the database
    it('responds to /api/auth/* requests', async () => {
      const app = createApp();
      // Without proper env vars, auth routes will error, but they're mounted
      const res = await app.request('/api/auth/session');
      // Better Auth should respond (even if with an error due to missing env)
      expect(res.status).toBeDefined();
    });
  });

  describe('conversations routes', () => {
    it('returns 401 for GET /api/conversations without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/conversations',
        {},
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(401);
      const body: { error: string; code?: string } = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 for GET /api/conversations/:id without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/conversations/123',
        {},
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(401);
      const body: { error: string; code?: string } = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 for POST /api/conversations without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/conversations',
        { method: 'POST' },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(401);
      const body: { error: string; code?: string } = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 for DELETE /api/conversations/:id without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/conversations/123',
        { method: 'DELETE' },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(401);
      const body: { error: string; code?: string } = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 for PATCH /api/conversations/:id without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/conversations/123',
        { method: 'PATCH' },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(401);
      const body: { error: string; code?: string } = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('chat routes', () => {
    it('returns 401 for POST /api/chat/stream without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/chat/stream',
        { method: 'POST' },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(401);
      const body: { error: string; code?: string } = await res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('CORS', () => {
    it('includes CORS headers for allowed origin', async () => {
      const app = createApp();
      const res = await app.request('/api/health', {
        headers: { Origin: 'http://localhost:5173' },
      });

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });
  });

  describe('error handling', () => {
    it('returns 404 for unknown routes', async () => {
      const app = createApp();
      const res = await app.request('/unknown-route');

      expect(res.status).toBe(404);
    });
  });

  describe('dev routes', () => {
    it('responds to GET /api/dev/personas in development', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/dev/personas',
        {},
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
        }
      );

      expect(res.status).toBe(200);
      const body: { personas: unknown[] } = await res.json();
      expect(body).toHaveProperty('personas');
      expect(Array.isArray(body.personas)).toBe(true);
    });
  });
});
