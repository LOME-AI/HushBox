import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
    return;
  };
}
