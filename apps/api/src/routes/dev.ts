import { Hono } from 'hono';
import { listDevPersonas, cleanupTestData } from '../services/dev/index.js';
import type { AppEnv } from '../types.js';

export function createDevRoute(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/personas', async (c) => {
    const db = c.get('db');
    const type = c.req.query('type') === 'test' ? 'test' : 'dev';
    const personas = await listDevPersonas(db, type);
    return c.json({ personas });
  });

  app.delete('/test-data', async (c) => {
    const db = c.get('db');
    const deleted = await cleanupTestData(db);
    return c.json({ success: true, deleted });
  });

  return app;
}
