import { cors as honoCors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

interface CorsBindings {
  FRONTEND_URL?: string;
}

const DEFAULT_ORIGIN = 'http://localhost:5173';

export function cors(): MiddlewareHandler<{ Bindings: CorsBindings }> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- c.env may be undefined in tests
    const frontendUrl = c.env?.FRONTEND_URL ?? DEFAULT_ORIGIN;
    const origins =
      frontendUrl === DEFAULT_ORIGIN ? [DEFAULT_ORIGIN] : [frontendUrl, DEFAULT_ORIGIN];

    const corsMiddleware = honoCors({
      origin: origins,
      credentials: true,
    });

    return corsMiddleware(c, next);
  };
}
