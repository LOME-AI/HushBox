import type { MiddlewareHandler } from 'hono';
import { ERROR_CODE_CSRF_REJECTED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';

interface CsrfEnv {
  Bindings: {
    FRONTEND_URL?: string;
  };
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * CSRF protection middleware using Origin header validation.
 *
 * For state-changing requests (POST, PUT, DELETE, PATCH):
 * - Requests without Origin header are allowed (same-origin requests)
 * - Requests with Origin header must match FRONTEND_URL
 *
 * GET/HEAD/OPTIONS requests are not affected.
 */
const csrfHandler: MiddlewareHandler<CsrfEnv> = async (c, next) => {
  if (!STATE_CHANGING_METHODS.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header('Origin');

  // No Origin header typically means same-origin request
  // (browsers add Origin for cross-origin requests)
  if (!origin) {
    return next();
  }

  const frontendUrl = c.env.FRONTEND_URL;
  if (!frontendUrl) {
    return c.json(createErrorResponse(ERROR_CODE_CSRF_REJECTED), 403);
  }

  try {
    const parsedOrigin = new URL(origin).origin;
    const parsedFrontend = new URL(frontendUrl).origin;

    if (parsedOrigin !== parsedFrontend) {
      return c.json(createErrorResponse(ERROR_CODE_CSRF_REJECTED), 403);
    }
  } catch {
    return c.json(createErrorResponse(ERROR_CODE_CSRF_REJECTED), 403);
  }

  return next();
};

export function csrfProtection(): MiddlewareHandler<CsrfEnv> {
  return csrfHandler;
}
