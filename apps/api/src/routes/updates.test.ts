import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { updatesRoute } from './updates.js';
import type { AppEnv } from '../types.js';

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createTestApp(options?: {
  appVersion?: string;
  r2Object?: { body: ReadableStream; size: number } | null;
}): Hono<AppEnv> {
  const appVersion = options?.appVersion ?? '1.0.0';
  const r2Object = options?.r2Object === undefined ? null : options.r2Object;

  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      APP_VERSION: appVersion,
      APP_BUILDS: {
        get: vi.fn().mockResolvedValue(r2Object),
        put: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AppEnv['Bindings'];
    await next();
  });

  app.route('/updates', updatesRoute);
  return app;
}

describe('GET /updates/current', () => {
  it('returns the current version from APP_VERSION', async () => {
    const app = createTestApp({ appVersion: 'abc123' });

    const res = await app.request('/updates/current');

    expect(res.status).toBe(200);
    const data = await jsonBody<{ version: string }>(res);
    expect(data.version).toBe('abc123');
  });

  it('returns version for dev-local', async () => {
    const app = createTestApp({ appVersion: 'dev-local' });

    const res = await app.request('/updates/current');

    expect(res.status).toBe(200);
    const data = await jsonBody<{ version: string }>(res);
    expect(data.version).toBe('dev-local');
  });
});

describe('GET /updates/download/:version', () => {
  it('returns 404 when version not found in R2', async () => {
    const app = createTestApp({ r2Object: null });

    const res = await app.request('/updates/download/nonexistent');

    expect(res.status).toBe(404);
    const data = await jsonBody<{ code: string }>(res);
    expect(data.code).toBe('BUILD_NOT_FOUND');
  });

  it('returns 404 when APP_BUILDS binding is not configured', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = { APP_VERSION: '1.0.0' } as unknown as AppEnv['Bindings'];
      await next();
    });
    app.route('/updates', updatesRoute);

    const res = await app.request('/updates/download/1.0.0');

    expect(res.status).toBe(404);
  });

  it('streams zip file from R2 with correct content type', async () => {
    const zipContent = new TextEncoder().encode('fake-zip-content');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(zipContent);
        controller.close();
      },
    });
    const r2Object = { body: stream, size: zipContent.length };
    const app = createTestApp({ r2Object });

    const res = await app.request('/updates/download/1.0.0');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(zipContent.length);
  });
});
