import type { MiddlewareHandler } from 'hono';
import { createEnvUtilities, ERROR_CODE_NOT_FOUND } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';

interface DevOnlyBindings {
  NODE_ENV?: string;
}

export function devOnly(): MiddlewareHandler<{ Bindings: DevOnlyBindings }> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next): Promise<Response | undefined> => {
    const env = createEnvUtilities(c.env);
    if (env.isProduction) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }
    await next();
    return undefined;
  };
}
