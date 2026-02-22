import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { cors } from './cors.js';

describe('cors middleware', () => {
  describe('without FRONTEND_URL (development)', () => {
    it('allows requests from localhost:5173', async () => {
      const app = new Hono();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('handles preflight OPTIONS requests', async () => {
      const app = new Hono();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });

    it('rejects requests from disallowed origins', async () => {
      const app = new Hono();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Origin: 'http://evil.com' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('with FRONTEND_URL (production)', () => {
    it('allows requests from production origin', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'https://hushbox.ai' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://hushbox.ai');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('still allows localhost when FRONTEND_URL is set', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'http://localhost:5173' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });

    it('handles preflight OPTIONS for production origin', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://hushbox.ai',
            'Access-Control-Request-Method': 'POST',
          },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://hushbox.ai');
    });

    it('rejects requests from disallowed origins in production', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'http://evil.com' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
