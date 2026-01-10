import { Hono } from 'hono';
import type { createAuth } from '../auth/index.js';

type Auth = ReturnType<typeof createAuth>;

export function createAuthRoutes(auth: Auth): Hono {
  const app = new Hono();

  // Mount Better Auth handler to process all auth requests
  app.all('/*', (c) => auth.handler(c.req.raw));

  return app;
}
