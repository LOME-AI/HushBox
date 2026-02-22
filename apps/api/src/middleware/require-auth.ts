import type { MiddlewareHandler } from 'hono';
import { ERROR_CODE_NOT_AUTHENTICATED } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';

/**
 * Middleware that requires authentication.
 * Returns 401 if no user is set on context.
 * Use this instead of inline auth checks in route handlers.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }
    return next();
  };
}
