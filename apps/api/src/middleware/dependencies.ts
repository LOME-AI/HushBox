import type { MiddlewareHandler } from 'hono';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@lome-chat/db';
import { createEnvUtils } from '@lome-chat/shared';
import { createAuth } from '../auth/index.js';
import { getEmailClient } from '../services/email/index.js';
import { getHelcimClient } from '../services/helcim/index.js';
import { getOpenRouterClient } from '../services/openrouter/index.js';
import type { AppEnv } from '../types.js';

export function dbMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { isDev } = createEnvUtils(c.env);
    const dbConfig = isDev
      ? { connectionString: c.env.DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG }
      : { connectionString: c.env.DATABASE_URL };
    c.set('db', createDb(dbConfig));
    await next();
  };
}

export function authMiddleware(): MiddlewareHandler<AppEnv> {
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
  return async (c, next) => {
    c.set('openrouter', getOpenRouterClient(c.env));
    await next();
  };
}

export function helcimMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('helcim', getHelcimClient(c.env));
    await next();
  };
}
