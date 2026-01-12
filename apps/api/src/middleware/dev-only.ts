import type { MiddlewareHandler } from 'hono';
import { createEnvUtils } from '@lome-chat/shared';

interface DevOnlyBindings {
  NODE_ENV?: string;
}

export function devOnly(): MiddlewareHandler<{ Bindings: DevOnlyBindings }> {
  return async (c, next): Promise<Response | undefined> => {
    const env = createEnvUtils(c.env);
    if (env.isProduction) {
      return c.json({ error: 'Not Found' }, 404);
    }
    await next();
    return undefined;
  };
}
