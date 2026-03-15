import { cors as honoCors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

interface CorsBindings {
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
}

/** Capacitor WebView origins (iOS + Android) */
const CAPACITOR_ORIGINS = ['capacitor://localhost', 'http://localhost'];

export function cors(): MiddlewareHandler<{ Bindings: CorsBindings }> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const origins = [
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- c.env may be undefined in tests
      ...(c.env?.FRONTEND_URL ? [c.env.FRONTEND_URL] : []),
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- c.env may be undefined in tests
      ...(c.env?.FRONTEND_PREVIEW_URL ? [c.env.FRONTEND_PREVIEW_URL] : []),
      ...CAPACITOR_ORIGINS,
    ];

    const corsMiddleware = honoCors({
      origin: origins,
      credentials: true,
    });

    return corsMiddleware(c, next);
  };
}
