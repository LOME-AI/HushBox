import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requirePhrase } from './require-phrase';

function createMockUser(hasAcknowledgedPhrase: boolean): AppEnv['Variables']['user'] {
  return {
    id: 'user-123',
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase,
    publicKey: new Uint8Array(32),
  };
}

describe('requirePhrase middleware', () => {
  it('returns 403 on POST when hasAcknowledgedPhrase is false', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', createMockUser(false));
      await next();
    });

    app.use('*', requirePhrase());
    app.post('/action', (c) => c.json({ message: 'success' }));

    const res = await app.request('/action', { method: 'POST' });

    expect(res.status).toBe(403);
    const data: { code: string } = await res.json();
    expect(data.code).toBe('PHRASE_REQUIRED');
  });

  it('allows POST when hasAcknowledgedPhrase is true', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', createMockUser(true));
      await next();
    });

    app.use('*', requirePhrase());
    app.post('/action', (c) => c.json({ message: 'success' }));

    const res = await app.request('/action', { method: 'POST' });

    expect(res.status).toBe(200);
    const data: { message: string } = await res.json();
    expect(data.message).toBe('success');
  });

  it('allows GET regardless of phrase status', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', createMockUser(false));
      await next();
    });

    app.use('*', requirePhrase());
    app.get('/action', (c) => c.json({ message: 'success' }));

    const res = await app.request('/action');

    expect(res.status).toBe(200);
    const data: { message: string } = await res.json();
    expect(data.message).toBe('success');
  });

  it('returns 403 when user is null on POST', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', null);
      await next();
    });

    app.use('*', requirePhrase());
    app.post('/action', (c) => c.json({ message: 'success' }));

    const res = await app.request('/action', { method: 'POST' });

    expect(res.status).toBe(403);
    const data: { code: string } = await res.json();
    expect(data.code).toBe('PHRASE_REQUIRED');
  });
});
