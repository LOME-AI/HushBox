import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getIronSession } from 'iron-session';
import { users, type Database } from '@hushbox/db';
import {
  textEncoder,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_2FA_REQUIRED,
  ERROR_CODE_DELETE_ACCOUNT_LOCKED,
  ERROR_CODE_INVALID_CONFIRMATION_PHRASE,
  ERROR_CODE_NO_PENDING_DELETE_ACCOUNT,
  ERROR_CODE_INCORRECT_PASSWORD,
  ERROR_CODE_INVALID_TOTP_CODE,
  ERROR_CODE_USER_NOT_FOUND,
  ERROR_CODE_SERVER_MISCONFIGURED,
  ERROR_CODE_INTERNAL,
} from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { getSessionOptions, type SessionData } from '../lib/session.js';
import { isLockedOut, recordFailedAttempt } from '../lib/rate-limit.js';
import { startOpaqueStepUp, finishOpaqueStepUp } from '../lib/opaque-step-up.js';
import { verifyTotpStepUp } from '../lib/totp-step-up.js';
import { deleteUser } from '../services/account-deletion/delete-user.js';
import { getMediaStorage } from '../services/storage/index.js';
import { getEmailClient } from '../services/email/index.js';
import type { Redis } from '@upstash/redis';
import type { AppEnv } from '../types.js';

/**
 * Required confirmation phrase. Compared case-insensitively and after trim
 * only — no Unicode normalization, which would let homoglyph inputs match.
 */
const CONFIRMATION_PHRASE = 'delete my account';

const initSchema = z.object({
  ke1: z.array(z.number()).min(1),
});

const finishSchema = z.object({
  ke3: z.array(z.number()).min(1),
  totpCode: z
    .string()
    .length(6)
    .regex(/^\d{6}$/)
    .optional(),
  confirmationPhrase: z.string(),
});

interface FinishUserRow {
  id: string;
  email: string | null;
  username: string;
  totpEnabled: boolean;
  totpSecretEncrypted: Uint8Array | null;
}

interface PreflightOk {
  ok: true;
  sessionData: SessionData;
}

interface PreflightFail {
  ok: false;
  code: string;
  status: 401 | 403 | 500;
  details?: { retryAfterSeconds: number };
}

interface GateOk {
  ok: true;
}

interface GateFail {
  ok: false;
  code: string;
  status: 400 | 500;
}

type GateResult = GateOk | GateFail;

async function recordDeleteAccountFailure(redis: Redis, userId: string): Promise<void> {
  await recordFailedAttempt(redis, 'deleteAccountUserRateLimit', userId, 'deleteAccountLockout');
}

/**
 * Common gating for both /init and /finish: requires an authenticated
 * non-pending-2FA session, requires OPAQUE config, then checks the
 * 24h lockout. Returns a tagged union so the caller can write a single
 * `if (preflight.ok)` block.
 */
function preflight(c: {
  get: (k: 'sessionData') => SessionData | null;
  env: AppEnv['Bindings'];
}): PreflightFail | (PreflightOk & { masterSecret: string; sessionSecret: string }) {
  const sessionData = c.get('sessionData');
  if (!sessionData?.userId) {
    return { ok: false, code: ERROR_CODE_NOT_AUTHENTICATED, status: 401 };
  }
  if (sessionData.pending2FA) {
    return { ok: false, code: ERROR_CODE_2FA_REQUIRED, status: 403 };
  }
  const masterSecret = c.env.OPAQUE_MASTER_SECRET;
  const sessionSecret = c.env.IRON_SESSION_SECRET;
  if (!masterSecret || !sessionSecret) {
    return { ok: false, code: ERROR_CODE_SERVER_MISCONFIGURED, status: 500 };
  }
  return { ok: true, sessionData, masterSecret, sessionSecret };
}

async function checkLockout(redis: Redis, userId: string): Promise<PreflightFail | null> {
  const lockout = await isLockedOut(redis, 'deleteAccountLockout', userId);
  if (!lockout.lockedOut) return null;
  return {
    ok: false,
    code: ERROR_CODE_DELETE_ACCOUNT_LOCKED,
    status: 403,
    details: { retryAfterSeconds: lockout.retryAfterSeconds },
  };
}

async function loadFinishUser(db: Database, userId: string): Promise<FinishUserRow | undefined> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      totpEnabled: users.totpEnabled,
      totpSecretEncrypted: users.totpSecretEncrypted,
    })
    .from(users)
    .where(eq(users.id, userId));
  return user;
}

async function verifyOpaqueGate(args: {
  redis: Redis;
  userId: string;
  ke3: number[];
}): Promise<GateResult> {
  const result = await finishOpaqueStepUp({
    ke3: new Uint8Array(args.ke3),
    userId: args.userId,
    redis: args.redis,
    redisKeyName: 'opaquePendingDeleteAccount',
  });
  if (result.ok) return { ok: true };
  if (result.reason === 'no-pending') {
    return { ok: false, code: ERROR_CODE_NO_PENDING_DELETE_ACCOUNT, status: 400 };
  }
  await recordDeleteAccountFailure(args.redis, args.userId);
  return { ok: false, code: ERROR_CODE_INCORRECT_PASSWORD, status: 400 };
}

async function verifyTotpGate(args: {
  redis: Redis;
  user: FinishUserRow;
  masterSecret: string;
  totpCode: string | undefined;
}): Promise<GateResult> {
  if (!args.user.totpEnabled) return { ok: true };
  if (!args.totpCode || !args.user.totpSecretEncrypted) {
    await recordDeleteAccountFailure(args.redis, args.user.id);
    return { ok: false, code: ERROR_CODE_INVALID_TOTP_CODE, status: 400 };
  }
  const result = await verifyTotpStepUp({
    redis: args.redis,
    userId: args.user.id,
    masterSecret: textEncoder.encode(args.masterSecret),
    encryptedSecret: args.user.totpSecretEncrypted,
    code: args.totpCode,
    now: new Date(),
  });
  if (result.ok) return { ok: true };
  await recordDeleteAccountFailure(args.redis, args.user.id);
  return { ok: false, code: ERROR_CODE_INVALID_TOTP_CODE, status: 400 };
}

/**
 * Saga is idempotent: a concurrent delete that already drained this user
 * yields `{ ok: false, reason: 'user-not-found' }` — that's still success
 * from the caller's perspective, so it returns `null`. Returns a truthy
 * error code only when the saga itself throws.
 */
async function runSagaSafely(args: {
  db: Database;
  env: AppEnv['Bindings'];
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<string | null> {
  try {
    await deleteUser({
      db: args.db,
      storage: getMediaStorage(args.env),
      email: getEmailClient(args.env),
      userId: args.userId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      now: new Date(),
    });
    return null;
  } catch {
    return ERROR_CODE_INTERNAL;
  }
}

export const deleteAccountRoute = new Hono<AppEnv>()
  .post('/init', zValidator('json', initSchema), async (c) => {
    const pre = preflight(c);
    if (!pre.ok) {
      return c.json(createErrorResponse(pre.code, pre.details), pre.status);
    }
    const redis = c.get('redis');
    const lockout = await checkLockout(redis, pre.sessionData.userId);
    if (lockout) {
      return c.json(createErrorResponse(lockout.code, lockout.details), lockout.status);
    }

    const db = c.get('db');
    const [user] = await db
      .select({ id: users.id, opaqueRegistration: users.opaqueRegistration })
      .from(users)
      .where(eq(users.id, pre.sessionData.userId));
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 500);
    }

    const { ke1 } = c.req.valid('json');
    const { ke2 } = await startOpaqueStepUp({
      ke1: new Uint8Array(ke1),
      userId: user.id,
      opaqueRegistration: user.opaqueRegistration,
      username: user.id,
      masterSecret: textEncoder.encode(pre.masterSecret),
      redis,
      redisKeyName: 'opaquePendingDeleteAccount',
    });
    return c.json({ ke2: [...ke2] }, 200);
  })

  .post('/finish', zValidator('json', finishSchema), async (c) => {
    const pre = preflight(c);
    if (!pre.ok) {
      return c.json(createErrorResponse(pre.code, pre.details), pre.status);
    }
    const redis = c.get('redis');
    const lockout = await checkLockout(redis, pre.sessionData.userId);
    if (lockout) {
      return c.json(createErrorResponse(lockout.code, lockout.details), lockout.status);
    }

    const { ke3, totpCode, confirmationPhrase } = c.req.valid('json');

    // Gate 1 — phrase: cheap, reveals no server state, runs before crypto.
    // Trim and lowercase only; Unicode normalization would create homoglyph
    // false matches.
    if (confirmationPhrase.trim().toLowerCase() !== CONFIRMATION_PHRASE) {
      return c.json(createErrorResponse(ERROR_CODE_INVALID_CONFIRMATION_PHRASE), 400);
    }

    const db = c.get('db');
    const user = await loadFinishUser(db, pre.sessionData.userId);
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 500);
    }

    const opaqueGate = await verifyOpaqueGate({ redis, userId: user.id, ke3 });
    if (!opaqueGate.ok) {
      return c.json(createErrorResponse(opaqueGate.code), opaqueGate.status);
    }
    const totpGate = await verifyTotpGate({
      redis,
      user,
      masterSecret: pre.masterSecret,
      totpCode,
    });
    if (!totpGate.ok) {
      return c.json(createErrorResponse(totpGate.code), totpGate.status);
    }

    const sagaError = await runSagaSafely({
      db,
      env: c.env,
      userId: user.id,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
    if (sagaError) {
      return c.json(createErrorResponse(ERROR_CODE_INTERNAL), 500);
    }

    const { isProduction } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(pre.sessionSecret, isProduction)
    );
    session.destroy();
    return c.body(null, 204);
  });
