import type { MiddlewareHandler } from 'hono';
import { ERROR_CODE_UNAUTHORIZED } from '@lome-chat/shared';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';
import { ERROR_UNAUTHORIZED } from '../constants/errors.js';

/**
 * Middleware that requires authentication.
 * Returns 401 if no user is set on context.
 * Use this instead of inline auth checks in route handlers.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED), 401);
    }
    await next();
    return;
  };
}
