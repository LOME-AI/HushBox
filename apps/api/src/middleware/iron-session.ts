import type { MiddlewareHandler } from 'hono';
import { getIronSession } from 'iron-session';
import { createEnvUtilities } from '@hushbox/shared';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, type SessionData } from '../lib/session.js';

export interface IronSessionConfig {
  cookieName: string;
  password: string;
}

interface IronSessionRequiredEnv {
  Bindings: {
    IRON_SESSION_SECRET?: string;
    NODE_ENV?: string;
  };
  Variables: {
    sessionData: SessionData | null;
  };
}

function isValidSession(session: unknown): session is SessionData {
  if (!session || typeof session !== 'object') {
    return false;
  }

  const s = session as Record<string, unknown>;
  return typeof s['userId'] === 'string' && s['userId'].length > 0;
}

/**
 * Iron-session middleware for OPAQUE authentication.
 *
 * Extracts session data from encrypted cookie and sets it on context.
 * Sets `sessionData` to null if no valid session exists.
 */
const ironSessionHandler: MiddlewareHandler<IronSessionRequiredEnv> = async (c, next) => {
  const secret = c.env.IRON_SESSION_SECRET;

  if (!secret) {
    c.set('sessionData', null);
    return next();
  }

  const { isProduction } = createEnvUtilities(c.env);

  const session = await getIronSession<SessionData>(c.req.raw, c.res, {
    password: secret,
    cookieName: SESSION_COOKIE_NAME,
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  });

  if (isValidSession(session)) {
    c.set('sessionData', session);
  } else {
    c.set('sessionData', null);
  }

  return next();
};

export function createIronSessionMiddleware(): MiddlewareHandler<IronSessionRequiredEnv> {
  return ironSessionHandler;
}
