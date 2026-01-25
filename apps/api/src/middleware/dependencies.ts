import type { MiddlewareHandler } from 'hono';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@lome-chat/db';
import { createEnvUtilities } from '@lome-chat/shared';
import { createAuth } from '../auth/index.js';
import { getEmailClient } from '../services/email/index.js';
import { getHelcimClient } from '../services/helcim/index.js';
import { getOpenRouterClient } from '../services/openrouter/index.js';
import type { AppEnv } from '../types.js';

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

export function authMiddleware(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const db = c.get('db');
    const emailClient = getEmailClient(c.env);

    const auth = createAuth({
      db,
      emailClient,
      baseUrl: c.env.BETTER_AUTH_URL ?? 'http://localhost:8787',
      secret: c.env.BETTER_AUTH_SECRET ?? 'dev-secret-minimum-32-characters-long',
      frontendUrl: c.env.FRONTEND_URL ?? 'http://localhost:5173',
    });

    c.set('auth', auth);
    await next();
  };
}

export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });

    if (sessionData) {
      c.set('user', sessionData.user as AppEnv['Variables']['user']);
      c.set('session', sessionData.session as AppEnv['Variables']['session']);
    } else {
      c.set('user', null);
      c.set('session', null);
    }

    await next();
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
