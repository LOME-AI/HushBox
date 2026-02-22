import type { MiddlewareHandler } from 'hono';
import { ERROR_CODE_PHRASE_REQUIRED } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';

/**
 * Middleware that requires recovery phrase acknowledgment for POST requests.
 * Returns 403 if user has not acknowledged their recovery phrase.
 * GET requests pass through unconditionally.
 */
export function requirePhrase(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    if (c.req.method === 'POST') {
      const user = c.get('user');
      if (!user?.hasAcknowledgedPhrase) {
        return c.json(createErrorResponse(ERROR_CODE_PHRASE_REQUIRED), 403);
      }
    }
    return next();
  };
}
