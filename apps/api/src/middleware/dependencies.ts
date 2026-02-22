import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import {
  createEnvUtilities,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_SESSION_REVOKED,
  ERROR_CODE_PASSWORD_CHANGED,
  ERROR_CODE_2FA_EXPIRED,
  ERROR_CODE_2FA_REQUIRED,
  ERROR_CODE_USER_NOT_FOUND,
} from '@hushbox/shared';
import { createRedisClient } from '../lib/redis.js';
import { createIronSessionMiddleware } from './iron-session.js';
import { getHelcimClient } from '../services/helcim/index.js';
import { getOpenRouterClient } from '../services/openrouter/index.js';
import type { AppEnv } from '../types.js';
import { createErrorResponse } from '../lib/error-response.js';

export function dbMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const { isDev } = c.get('envUtils');
    const dbConfig = isDev
      ? { connectionString: c.env.DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG }
      : { connectionString: c.env.DATABASE_URL };
    c.set('db', createDb(dbConfig));
    await next();
  };
}

export function redisMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const url = c.env.UPSTASH_REDIS_REST_URL;
    const token = c.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
    }
    const redis = createRedisClient(url, token);
    c.set('redis', redis);
    await next();
  };
}

export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    // Check session is active in Redis
    const redis = c.get('redis');
    const { redisGet } = await import('../lib/redis-registry.js');
    const sessionActive = await redisGet(
      redis,
      'sessionActive',
      sessionData.userId,
      sessionData.sessionId
    );
    if (!sessionActive) {
      return c.json(createErrorResponse(ERROR_CODE_SESSION_REVOKED), 401);
    }

    // Check session predates password change
    const passwordChangedAt = await redisGet(redis, 'passwordChangedAt', sessionData.userId);
    if (passwordChangedAt && sessionData.createdAt < passwordChangedAt) {
      return c.json(createErrorResponse(ERROR_CODE_PASSWORD_CHANGED), 401);
    }

    // Check pending 2FA gate
    if (sessionData.pending2FA) {
      if (sessionData.pending2FAExpiresAt < Date.now()) {
        return c.json(createErrorResponse(ERROR_CODE_2FA_EXPIRED), 401);
      }
      return c.json(createErrorResponse(ERROR_CODE_2FA_REQUIRED), 403);
    }

    const db = c.get('db');
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        emailVerified: users.emailVerified,
        totpEnabled: users.totpEnabled,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
        publicKey: users.publicKey,
      })
      .from(users)
      .where(eq(users.id, sessionData.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 404);
    }

    c.set('user', user);
    c.set('session', sessionData);
    return next();
  };
}

export function openRouterMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const db = c.get('db');
    const { isCI } = c.get('envUtils');
    c.set('openrouter', getOpenRouterClient(c.env, { db, isCI }));
    await next();
  };
}

export function helcimMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    c.set('helcim', getHelcimClient(c.env));
    await next();
  };
}

export function envMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    // c.env may be undefined in tests when app.request() is called without bindings
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    c.set('envUtils', createEnvUtilities(c.env ?? {}));
    await next();
  };
}

export function ironSessionMiddleware(): MiddlewareHandler {
  return createIronSessionMiddleware();
}
