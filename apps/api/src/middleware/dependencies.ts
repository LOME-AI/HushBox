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
  ERROR_CODE_BILLING_SESSION_RESTRICTED,
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

/** Validates session state against Redis. Returns error code + status or null if valid. */
async function validateSessionState(
  sessionData: {
    userId: string;
    sessionId: string;
    createdAt: number;
    pending2FA: boolean;
    pending2FAExpiresAt: number;
    billingOnly?: boolean;
  },
  redis: AppEnv['Variables']['redis'],
  requestPath: string
): Promise<{ code: string; status: 401 | 403 } | null> {
  const { redisGet } = await import('../lib/redis-registry.js');

  const sessionActive = await redisGet(
    redis,
    'sessionActive',
    sessionData.userId,
    sessionData.sessionId
  );
  if (!sessionActive) return { code: ERROR_CODE_SESSION_REVOKED, status: 401 };

  const passwordChangedAt = await redisGet(redis, 'passwordChangedAt', sessionData.userId);
  if (passwordChangedAt && sessionData.createdAt < passwordChangedAt) {
    return { code: ERROR_CODE_PASSWORD_CHANGED, status: 401 };
  }

  if (sessionData.pending2FA) {
    if (sessionData.pending2FAExpiresAt < Date.now()) {
      return { code: ERROR_CODE_2FA_EXPIRED, status: 401 };
    }
    return { code: ERROR_CODE_2FA_REQUIRED, status: 403 };
  }

  if (sessionData.billingOnly) {
    const isBillingOrAuth =
      requestPath.startsWith('/api/billing') || requestPath.startsWith('/api/auth');
    if (!isBillingOrAuth) return { code: ERROR_CODE_BILLING_SESSION_RESTRICTED, status: 403 };
  }

  return null;
}

export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    const rejection = await validateSessionState(sessionData, c.get('redis'), c.req.path);
    if (rejection) {
      return c.json(createErrorResponse(rejection.code), rejection.status);
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
