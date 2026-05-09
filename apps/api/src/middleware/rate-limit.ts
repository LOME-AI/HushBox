import { ERROR_CODE_NOT_AUTHENTICATED, ERROR_CODE_RATE_LIMITED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getClientIp, hashIp } from '../lib/client-ip.js';
import type { AppEnv } from '../types.js';
import type { MiddlewareHandler } from 'hono';
import type { REDIS_REGISTRY } from '../lib/redis-registry.js';

type RateLimitKeyName = {
  [K in keyof typeof REDIS_REGISTRY]: (typeof REDIS_REGISTRY)[K] extends {
    rateLimitConfig: unknown;
  }
    ? K
    : never;
}[keyof typeof REDIS_REGISTRY];

/**
 * Per-user rate limit middleware.
 *
 * Caps requests per authenticated user per window. Use for endpoints where
 * the cost-amplification target is bound to the user (chat streaming →
 * AI gateway calls, share creation → DB writes, media presign → signing path).
 *
 * Returns 401 if no user is set on context — per-user limiting is impossible
 * without an authenticated principal, and silently ignoring would let a
 * misconfigured route bypass the cap.
 */
export function rateLimitByUser(keyName: RateLimitKeyName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }
    const redis = c.get('redis');
    const result = await checkRateLimit(redis, keyName, user.id);
    if (!result.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
        429
      );
    }
    return next();
  };
}

/**
 * Per-IP rate limit middleware.
 *
 * Caps requests per client IP per window. Use for unauthenticated endpoints
 * (public share lookup) where there is no user principal — the IP is the
 * only available identity. The IP is hashed before being used as a Redis
 * key to avoid storing raw addresses.
 */
export function rateLimitByIp(keyName: RateLimitKeyName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const redis = c.get('redis');
    const ip = getClientIp(c);
    const ipHash = hashIp(ip);
    const result = await checkRateLimit(redis, keyName, ipHash);
    if (!result.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
        429
      );
    }
    return next();
  };
}
