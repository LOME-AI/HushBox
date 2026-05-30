import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, gt } from 'drizzle-orm';
import { getIronSession, type IronSession } from 'iron-session';
import { users } from '@hushbox/db';
import {
  textEncoder,
  normalizeUsername,
  displayUsername,
  toBase64,
  fromBase64,
  ERROR_CODE_AUTH_FAILED,
  ERROR_CODE_LOGIN_INIT_FAILED,
  ERROR_CODE_NO_PENDING_LOGIN,
  ERROR_CODE_NO_PENDING_REGISTRATION,
  ERROR_CODE_REGISTRATION_FAILED,
  ERROR_CODE_USER_CREATION_FAILED,
  ERROR_CODE_USERNAME_TAKEN,
  ERROR_CODE_EMAIL_TAKEN,
  ERROR_CODE_EMAIL_NOT_VERIFIED,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_INCORRECT_PASSWORD,
  ERROR_CODE_INVALID_OR_EXPIRED_TOKEN,
  ERROR_CODE_INVALID_TOTP_CODE,
  ERROR_CODE_TOTP_NOT_CONFIGURED,
  ERROR_CODE_TOTP_NOT_ENABLED,
  ERROR_CODE_TOTP_ALREADY_ENABLED,
  ERROR_CODE_2FA_REQUIRED,
  ERROR_CODE_2FA_EXPIRED,
  ERROR_CODE_NO_PENDING_2FA,
  ERROR_CODE_NO_PENDING_2FA_SETUP,
  ERROR_CODE_NO_PENDING_DISABLE,
  ERROR_CODE_DISABLE_2FA_INIT_FAILED,
  ERROR_CODE_USER_NOT_FOUND,
  ERROR_CODE_SERVER_MISCONFIGURED,
  ERROR_CODE_INVALID_BASE64,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_TOO_MANY_ATTEMPTS,
  ERROR_CODE_NO_PENDING_CHANGE,
  ERROR_CODE_NO_PENDING_RECOVERY,
  ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED,
  ERROR_CODE_CHANGE_PASSWORD_REG_FAILED,
  ERROR_CODE_SESSION_REVOKED,
} from '@hushbox/shared';
import {
  OpaqueServerRegistrationRequest as RegistrationRequest,
  OpaqueRegistrationRecord as RegistrationRecord,
  OpaqueKE1 as KE1,
  OpaqueKE3 as KE3,
  OpaqueExpectedAuthResult as ExpectedAuthResult,
  createOpaqueServerFromEnv,
  createFakeRegistrationRecord,
  OpaqueServerConfig,
  generateTotpSecret,
  generateTotpUri,
  encryptTotpSecret,
  deriveTotpEncryptionKey,
} from '@hushbox/crypto';
import { createErrorResponse } from '../lib/error-response.js';
import { getUniqueViolationConstraint } from '../lib/unique-violation.js';
import { getSessionOptions, type SessionData } from '../lib/session.js';
import {
  checkRateLimit,
  checkDualRateLimit,
  recordFailedAttempt,
  isLockedOut,
  clearLockout,
} from '../lib/rate-limit.js';
import { getClientIp, hashIp } from '../lib/client-ip.js';
import { redisGet, redisSet, redisDel, REDIS_REGISTRY } from '../lib/redis-registry.js';
import { startOpaqueStepUp, finishOpaqueStepUp } from '../lib/opaque-step-up.js';
import { verifyTotpStepUp, verifyTotpSetupCode } from '../lib/totp-step-up.js';
import { getEmailClient } from '../services/email/index.js';
import { ensureWalletsExist } from '../services/billing/wallet-provisioning.js';
import {
  verificationEmail,
  welcomeEmail,
  passwordChangedEmail,
  twoFactorEnabledEmail,
  twoFactorDisabledEmail,
  accountLockedEmail,
} from '../services/email/templates/index.js';
import { EMAIL_VERIFY_TOKEN_EXPIRY_MS } from '../constants/auth.js';
import type { AppEnv, Bindings } from '../types.js';

const PENDING_2FA_LOGIN_SECONDS = 5 * 60; // 5 minutes

/**
 * Handle a failed login attempt: clean up pending state, record failure, and
 * send lockout notification if the account was locked.
 */
async function handleLoginFailure(options: {
  redis: import('@upstash/redis').Redis;
  db: ReturnType<typeof import('@hushbox/db').createDb>;
  env: Bindings;
  identifier: string;
  userIdentifier: string;
  pendingUserId: string | null;
}): Promise<void> {
  await redisDel(options.redis, 'opaquePendingLogin', options.identifier);
  const failureResult = await recordFailedAttempt(
    options.redis,
    'loginUserRateLimit',
    options.userIdentifier,
    'loginLockout'
  );

  if (failureResult.lockoutTriggered && options.pendingUserId) {
    const lockoutDurationMinutes = Math.floor(REDIS_REGISTRY.loginLockout.ttl / 60);
    await sendNotificationEmail(options.db, options.env, options.pendingUserId, (u) => ({
      subject: 'Your account has been temporarily locked',
      content: accountLockedEmail({
        userName: displayUsername(u.username),
        lockoutMinutes: lockoutDurationMinutes,
      }),
    }));
  }
}

type Pending2FAResult =
  | { valid: true; userId: string }
  | { valid: false; error: string; status: 400 | 401 };

/**
 * Validate that the session has a pending 2FA flow: authenticated, pending flag set, not expired.
 */
function validatePending2FASession(session: IronSession<SessionData>): Pending2FAResult {
  if (!session.userId) {
    return { valid: false, error: ERROR_CODE_NOT_AUTHENTICATED, status: 401 };
  }
  if (!session.pending2FA) {
    return { valid: false, error: ERROR_CODE_NO_PENDING_2FA, status: 400 };
  }
  if (session.pending2FAExpiresAt < Date.now()) {
    session.destroy();
    return { valid: false, error: ERROR_CODE_2FA_EXPIRED, status: 401 };
  }
  return { valid: true, userId: session.userId };
}

type TotpUserResult =
  | { found: true; user: { id: string; totpSecretEncrypted: Uint8Array } }
  | { found: false; error: string; status: 400 | 500 };

/**
 * Look up a user by ID and validate that TOTP is enabled and configured.
 */
async function getUserWithTotpConfig(
  db: ReturnType<typeof import('@hushbox/db').createDb>,
  userId: string
): Promise<TotpUserResult> {
  const [user] = await db
    .select({
      id: users.id,
      totpEnabled: users.totpEnabled,
      totpSecretEncrypted: users.totpSecretEncrypted,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    return { found: false, error: ERROR_CODE_USER_NOT_FOUND, status: 500 };
  }
  if (!user.totpEnabled) {
    return { found: false, error: ERROR_CODE_TOTP_NOT_ENABLED, status: 400 };
  }
  if (!user.totpSecretEncrypted) {
    return { found: false, error: ERROR_CODE_TOTP_NOT_CONFIGURED, status: 500 };
  }
  return {
    found: true,
    user: { id: user.id, totpSecretEncrypted: user.totpSecretEncrypted },
  };
}

/**
 * Helper function to send notification emails in a fire-and-forget manner.
 * Queries the user to get their email and name, then sends an email.
 * Email send failures do not block the operation.
 */
async function sendNotificationEmail(
  db: ReturnType<typeof import('@hushbox/db').createDb>,
  env: Bindings,
  userId: string,
  buildEmail: (user: { email: string; username: string }) => {
    subject: string;
    content: { html: string; text: string };
  }
): Promise<void> {
  const [user] = await db
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.email) return;

  try {
    const emailClient = getEmailClient(env);
    const { subject, content } = buildEmail({ email: user.email, username: user.username });
    await emailClient.sendEmail({
      to: user.email,
      subject,
      html: content.html,
      text: content.text,
    });
  } catch {
    // Email notification failure should not block the operation
  }
}

/**
 * Resolve an identifier (email or username) to a Drizzle WHERE condition.
 * Emails contain '@'; usernames never do.
 */
function resolveIdentifierCondition(identifier: string): ReturnType<typeof eq> {
  const isEmail = identifier.includes('@');
  return isEmail
    ? eq(users.email, identifier.toLowerCase())
    : eq(users.username, identifier.toLowerCase());
}

const registerInitRequestSchema = z.object({
  email: z.email(),
  username: z.string().min(1),
  registrationRequest: z.array(z.number()).min(1),
});

const registerFinishRequestSchema = z.object({
  email: z.email(),
  registrationRecord: z.array(z.number()).min(1),
  accountPublicKey: z.string().min(1),
  passwordWrappedPrivateKey: z.string().min(1),
  recoveryWrappedPrivateKey: z.string().min(1),
});

const loginInitRequestSchema = z.object({
  identifier: z.string().min(1).max(254),
  ke1: z.array(z.number()).min(1),
});

const loginFinishRequestSchema = z.object({
  identifier: z.string().min(1).max(254),
  ke3: z.array(z.number()).min(1),
});

const login2FAVerifyRequestSchema = z.object({
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});

const twoFactorVerifyRequestSchema = z.object({
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});

const twoFactorDisableInitRequestSchema = z.object({
  ke1: z.array(z.number()).min(1),
});

const twoFactorDisableFinishRequestSchema = z.object({
  ke3: z.array(z.number()).min(1),
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});

const verifyEmailRequestSchema = z.object({
  token: z.string().min(1),
});

const resendVerificationRequestSchema = z.object({
  email: z.email(),
});

const changePasswordInitRequestSchema = z.object({
  ke1: z.array(z.number()).min(1),
  newRegistrationRequest: z.array(z.number()).min(1),
});

const changePasswordFinishRequestSchema = z.object({
  ke3: z.array(z.number()).min(1),
  newRegistrationRecord: z.array(z.number()).min(1),
  newPasswordWrappedPrivateKey: z.string().min(1),
});

const recoveryResetRequestSchema = z.object({
  identifier: z.string().min(1).max(254),
  newRegistrationRequest: z.array(z.number()).min(1),
});

const recoveryResetFinishRequestSchema = z.object({
  identifier: z.string().min(1).max(254),
  newRegistrationRecord: z.array(z.number()).min(1),
  newPasswordWrappedPrivateKey: z.string().min(1),
});

const recoveryGetWrappedKeyRequestSchema = z.object({
  identifier: z.string().min(1).max(254),
});

const recoverySaveRequestSchema = z.object({
  recoveryWrappedPrivateKey: z.string().min(1),
});

interface AuthEnvWithSession {
  masterSecret: string;
  frontendUrl: string;
  sessionSecret: string;
}

function getAuthEnvWithSession(env: Bindings): AuthEnvWithSession | null {
  const {
    OPAQUE_MASTER_SECRET: masterSecret,
    FRONTEND_URL: frontendUrl,
    IRON_SESSION_SECRET: sessionSecret,
  } = env;
  if (!masterSecret || !frontendUrl || !sessionSecret) return null;
  return { masterSecret, frontendUrl, sessionSecret };
}

export const opaqueAuthRoute = new Hono<AppEnv>()

  .post('/register/init', zValidator('json', registerInitRequestSchema), async (c) => {
    const { email, username, registrationRequest } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const frontendUrl = c.env.FRONTEND_URL;

    if (!masterSecret || !frontendUrl) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    // Dual-key rate limiting (email + IP)
    const ip = getClientIp(c);
    const ipHash = hashIp(ip);
    const rateResult = await checkDualRateLimit({
      redis,
      userKeyName: 'registerEmailRateLimit',
      ipKeyName: 'registerIpRateLimit',
      userIdentifier: email.toLowerCase(),
      ipHash,
    });
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    const existingUser = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    const userExists = existingUser.length > 0;

    // Pre-generate user ID for OPAQUE credential identifier
    const userId = crypto.randomUUID();

    // Create OPAQUE server and process registration request
    // Always process request to prevent user enumeration
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret);

    const request = RegistrationRequest.deserialize(OpaqueServerConfig, registrationRequest);
    const credentialIdentifier = userId;

    const result = await opaqueServer.registerInit(request, credentialIdentifier);
    if (result instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_REGISTRATION_FAILED), 500);
    }

    await redisSet(
      redis,
      'opaquePendingRegistration',
      {
        email: email.toLowerCase(),
        username: normalizeUsername(username),
        userId,
        ...(userExists && { existing: true }),
      },
      email
    );

    return c.json(
      {
        registrationResponse: result.serialize(),
      },
      200
    );
  })

  .post('/register/finish', zValidator('json', registerFinishRequestSchema), async (c) => {
    const {
      email,
      registrationRecord,
      accountPublicKey,
      passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey,
    } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');

    const pendingData = await redisGet(redis, 'opaquePendingRegistration', email);
    if (!pendingData) {
      return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_REGISTRATION), 400);
    }

    const pending = pendingData;

    // If this is a fake registration for an existing user, skip DB insert
    if (pending.existing) {
      await redisDel(redis, 'opaquePendingRegistration', email);

      // Return success with a fake userId (prevents enumeration)
      return c.json(
        {
          success: true,
          userId: crypto.randomUUID(),
        },
        201
      );
    }

    const record = RegistrationRecord.deserialize(OpaqueServerConfig, registrationRecord);
    const recordBytes = new Uint8Array(record.serialize());

    const publicKeyBytes = fromBase64(accountPublicKey);
    const passwordWrappedPrivateKeyBytes = fromBase64(passwordWrappedPrivateKey);
    const recoveryWrappedPrivateKeyBytes = fromBase64(recoveryWrappedPrivateKey);

    // Catch users_username_unique / users_email_unique violations explicitly
    // so a username race or an email-existence race past /init surfaces as a
    // typed 409 the signup UI can render — without this, both fall through
    // to the global handler as a generic INTERNAL 500.
    let newUser: { id: string } | undefined;
    try {
      const result = await db
        .insert(users)
        .values({
          id: pending.userId,
          email: pending.email,
          username: pending.username,
          opaqueRegistration: recordBytes,
          publicKey: publicKeyBytes,
          passwordWrappedPrivateKey: passwordWrappedPrivateKeyBytes,
          recoveryWrappedPrivateKey: recoveryWrappedPrivateKeyBytes,
          emailVerified: false,
        })
        .returning({ id: users.id });
      newUser = result[0];
    } catch (error) {
      const constraint = getUniqueViolationConstraint(error);
      if (constraint === 'users_username_unique') {
        return c.json(createErrorResponse(ERROR_CODE_USERNAME_TAKEN), 409);
      }
      if (constraint === 'users_email_unique') {
        return c.json(createErrorResponse(ERROR_CODE_EMAIL_TAKEN), 409);
      }
      // Either a generic unique violation we can't discriminate, or an
      // unrelated DB error. Let the global handler surface it as INTERNAL.
      throw error;
    }

    if (!newUser) {
      return c.json(createErrorResponse(ERROR_CODE_USER_CREATION_FAILED), 500);
    }

    // Provision wallets (purchased with welcome credit + free tier with daily allowance)
    await ensureWalletsExist(db, newUser.id);

    await redisDel(redis, 'opaquePendingRegistration', email);

    // Send verification email (fire-and-forget, don't block registration)
    const emailToken = crypto.randomUUID();
    const emailExpires = new Date(Date.now() + EMAIL_VERIFY_TOKEN_EXPIRY_MS);

    await db
      .update(users)
      .set({
        emailVerifyToken: emailToken,
        emailVerifyExpires: emailExpires,
      })
      .where(eq(users.id, newUser.id));

    const frontendUrl = c.env.FRONTEND_URL;
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL is required');
    }
    const verificationUrl = `${frontendUrl}/verify?token=${emailToken}`;

    try {
      const emailClient = getEmailClient(c.env);
      const content = verificationEmail({
        userName: displayUsername(pending.username),
        verificationUrl,
      });
      await emailClient.sendEmail({
        to: pending.email,
        subject: 'Verify your email address',
        html: content.html,
        text: content.text,
      });

      // Send welcome email (separate from verification)
      const welcomeContent = welcomeEmail({
        userName: displayUsername(pending.username),
      });
      await emailClient.sendEmail({
        to: pending.email,
        subject: 'Welcome to HushBox',
        html: welcomeContent.html,
        text: welcomeContent.text,
      });
    } catch {
      // Email send failure should not block registration
    }

    return c.json(
      {
        success: true,
        userId: newUser.id,
      },
      201
    );
  })

  .post('/login/init', zValidator('json', loginInitRequestSchema), async (c) => {
    const { identifier, ke1 } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const frontendUrl = c.env.FRONTEND_URL;

    if (!masterSecret || !frontendUrl) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const lookupCondition = resolveIdentifierCondition(identifier);

    // Look up user first so we can rate-limit by userId when found
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret);
    const existingUsers = await db.select().from(users).where(lookupCondition);
    const user = existingUsers[0];

    // Rate limit key: userId when found, identifier when not (prevents bypass via different identifiers)
    const userIdentifier = user?.id ?? identifier.toLowerCase();

    // Rate limiting: check lockout first, then rate limit
    const lockout = await isLockedOut(redis, 'loginLockout', userIdentifier);
    if (lockout.lockedOut) {
      return c.json(
        createErrorResponse(ERROR_CODE_TOO_MANY_ATTEMPTS, {
          retryAfterSeconds: lockout.retryAfterSeconds,
        }),
        429
      );
    }

    const ip = getClientIp(c);
    const ipHash = hashIp(ip);

    const rateResult = await checkDualRateLimit({
      redis,
      userKeyName: 'loginUserRateLimit',
      ipKeyName: 'loginIpRateLimit',
      userIdentifier,
      ipHash,
    });
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    let registrationRecord: RegistrationRecord;
    let userId: string | null;
    let credentialIdentifier: string;

    if (user) {
      registrationRecord = RegistrationRecord.deserialize(OpaqueServerConfig, [
        ...user.opaqueRegistration,
      ]);
      userId = user.id;
      credentialIdentifier = user.id;
    } else {
      // Use fake record to prevent user enumeration
      const masterSecretBytes = textEncoder.encode(masterSecret);
      const fake = await createFakeRegistrationRecord(masterSecretBytes);
      registrationRecord = fake.registrationRecord;
      userId = null;
      credentialIdentifier = identifier.toLowerCase();
    }

    const ke1Message = KE1.deserialize(OpaqueServerConfig, ke1);

    const result = await opaqueServer.authInit(
      ke1Message,
      registrationRecord,
      credentialIdentifier
    );
    if (result instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_LOGIN_INIT_FAILED), 500);
    }

    const { ke2, expected } = result;

    await redisSet(
      redis,
      'opaquePendingLogin',
      { identifier: identifier.toLowerCase(), userId, expectedSerialized: expected.serialize() },
      identifier
    );

    return c.json(
      {
        ke2: ke2.serialize(),
      },
      200
    );
  })

  .post('/login/finish', zValidator('json', loginFinishRequestSchema), async (c) => {
    const { identifier, ke3 } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const authEnv = getAuthEnvWithSession(c.env);
    if (!authEnv) return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    const { masterSecret, sessionSecret } = authEnv;

    const pendingData = await redisGet(redis, 'opaquePendingLogin', identifier);
    if (!pendingData) {
      return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_LOGIN), 400);
    }

    const pending = pendingData;

    const opaqueServer = await createOpaqueServerFromEnv(masterSecret);

    const ke3Message = KE3.deserialize(OpaqueServerConfig, ke3);
    const expected = ExpectedAuthResult.deserialize(OpaqueServerConfig, pending.expectedSerialized);

    const result = opaqueServer.authFinish(ke3Message, expected);
    if (result instanceof Error) {
      const userIdentifier = pending.userId ?? identifier.toLowerCase();
      await handleLoginFailure({
        redis,
        db,
        env: c.env,
        identifier: identifier.toLowerCase(),
        userIdentifier,
        pendingUserId: pending.userId,
      });
      return c.json(createErrorResponse(ERROR_CODE_AUTH_FAILED), 401);
    }

    if (!pending.userId) {
      await redisDel(redis, 'opaquePendingLogin', identifier);
      return c.json(createErrorResponse(ERROR_CODE_AUTH_FAILED), 401);
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        emailVerified: users.emailVerified,
        totpEnabled: users.totpEnabled,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
        passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
      })
      .from(users)
      .where(eq(users.id, pending.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_AUTH_FAILED), 401);
    }

    // Check email verification (skip for no-email users)
    if (user.email && !user.emailVerified) {
      await redisDel(redis, 'opaquePendingLogin', identifier);
      return c.json(createErrorResponse(ERROR_CODE_EMAIL_NOT_VERIFIED), 401);
    }

    await redisDel(redis, 'opaquePendingLogin', identifier);

    await clearLockout(redis, 'loginLockout', user.id, 'loginUserRateLimit');

    const { isProduction } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(sessionSecret, isProduction)
    );

    session.sessionId = crypto.randomUUID();
    session.userId = user.id;
    session.email = user.email;
    session.username = user.username;
    session.emailVerified = user.emailVerified;
    session.totpEnabled = user.totpEnabled;
    session.hasAcknowledgedPhrase = user.hasAcknowledgedPhrase;
    session.createdAt = Date.now();

    if (user.totpEnabled) {
      session.pending2FA = true;
      session.pending2FAExpiresAt = Date.now() + PENDING_2FA_LOGIN_SECONDS * 1000;
      await session.save();
      await redisSet(redis, 'sessionActive', '1', user.id, session.sessionId);
      return c.json({ requires2FA: true as const, userId: user.id }, 200);
    }

    session.pending2FA = false;
    session.pending2FAExpiresAt = 0;
    await session.save();
    await redisSet(redis, 'sessionActive', '1', user.id, session.sessionId);

    const passwordWrappedPrivateKeyBase64 = toBase64(user.passwordWrappedPrivateKey);

    return c.json(
      {
        success: true as const,
        userId: user.id,
        email: user.email,
        passwordWrappedPrivateKey: passwordWrappedPrivateKeyBase64,
      },
      200
    );
  })

  .post('/login/2fa/verify', zValidator('json', login2FAVerifyRequestSchema), async (c) => {
    const { code } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const sessionSecret = c.env.IRON_SESSION_SECRET;

    if (!sessionSecret || !masterSecret) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const { isProduction: isProduction } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(sessionSecret, isProduction)
    );

    const sessionCheck = validatePending2FASession(session);
    if (!sessionCheck.valid) {
      return c.json(createErrorResponse(sessionCheck.error), sessionCheck.status);
    }

    const lockout = await isLockedOut(redis, 'twoFactorLockout', sessionCheck.userId);
    if (lockout.lockedOut) {
      return c.json(
        createErrorResponse(ERROR_CODE_TOO_MANY_ATTEMPTS, {
          retryAfterSeconds: lockout.retryAfterSeconds,
        }),
        429
      );
    }

    const rateResult = await checkRateLimit(redis, 'twoFactorUserRateLimit', sessionCheck.userId);
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    const [userRow] = await db
      .select({
        id: users.id,
        totpSecretEncrypted: users.totpSecretEncrypted,
        passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
      })
      .from(users)
      .where(eq(users.id, sessionCheck.userId));

    if (!userRow?.totpSecretEncrypted) {
      return c.json(createErrorResponse(ERROR_CODE_TOTP_NOT_CONFIGURED), 500);
    }

    const result = await verifyTotpStepUp({
      redis,
      userId: sessionCheck.userId,
      masterSecret: textEncoder.encode(masterSecret),
      encryptedSecret: userRow.totpSecretEncrypted,
      code,
      now: new Date(),
    });
    if (!result.ok) {
      await recordFailedAttempt(
        redis,
        'twoFactorUserRateLimit',
        sessionCheck.userId,
        'twoFactorLockout'
      );
      return c.json(createErrorResponse(ERROR_CODE_INVALID_TOTP_CODE), 400);
    }

    // Session rotation: delete old session, generate new ID, save
    const oldSessionId = session.sessionId;
    await redisDel(redis, 'sessionActive', sessionCheck.userId, oldSessionId);

    const newSessionId = crypto.randomUUID();
    session.sessionId = newSessionId;
    session.pending2FA = false;
    session.pending2FAExpiresAt = 0;
    await session.save();

    await redisSet(redis, 'sessionActive', '1', sessionCheck.userId, newSessionId);

    await clearLockout(redis, 'twoFactorLockout', sessionCheck.userId, 'twoFactorUserRateLimit');

    return c.json(
      {
        success: true as const,
        passwordWrappedPrivateKey: toBase64(userRow.passwordWrappedPrivateKey),
        userId: userRow.id,
      },
      200
    );
  })

  .get('/me', async (c) => {
    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    // Validate session is still active in Redis (matches sessionMiddleware behavior)
    const redis = c.get('redis');
    const sessionActive = await redisGet(
      redis,
      'sessionActive',
      sessionData.userId,
      sessionData.sessionId
    );
    if (!sessionActive) {
      return c.json(createErrorResponse(ERROR_CODE_SESSION_REVOKED), 401);
    }

    const db = c.get('db');
    const isPending = sessionData.pending2FA;

    // Single query — fetch all fields, conditionally expose crypto fields
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        emailVerified: users.emailVerified,
        totpEnabled: users.totpEnabled,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
        passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
        publicKey: users.publicKey,
        customInstructionsEncrypted: users.customInstructionsEncrypted,
      })
      .from(users)
      .where(eq(users.id, sessionData.userId));

    if (!row) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 404);
    }

    const user = {
      id: row.id,
      email: row.email,
      username: row.username,
      emailVerified: row.emailVerified,
      totpEnabled: row.totpEnabled,
      hasAcknowledgedPhrase: row.hasAcknowledgedPhrase,
    };

    if (isPending) {
      return c.json({ user, pending2FA: true as const }, 200);
    }

    return c.json(
      {
        user,
        passwordWrappedPrivateKey: toBase64(row.passwordWrappedPrivateKey),
        publicKey: toBase64(row.publicKey),
        customInstructionsEncrypted: row.customInstructionsEncrypted
          ? toBase64(row.customInstructionsEncrypted)
          : null,
      },
      200
    );
  })

  .post('/logout', async (c) => {
    const sessionSecret = c.env.IRON_SESSION_SECRET;
    if (!sessionSecret) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json({ success: true }, 200);
    }

    const redis = c.get('redis');
    await redisDel(redis, 'sessionActive', sessionData.userId, sessionData.sessionId);

    const { isProduction: isProductionLogout } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(sessionSecret, isProductionLogout)
    );
    session.destroy();

    return c.json({ success: true }, 200);
  })

  .post('/2fa/setup', async (c) => {
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    if (sessionData.pending2FA) {
      return c.json(createErrorResponse(ERROR_CODE_2FA_REQUIRED), 401);
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        totpEnabled: users.totpEnabled,
      })
      .from(users)
      .where(eq(users.id, sessionData.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 500);
    }

    if (user.totpEnabled) {
      return c.json(createErrorResponse(ERROR_CODE_TOTP_ALREADY_ENABLED), 400);
    }

    const totpKey = deriveTotpEncryptionKey(textEncoder.encode(masterSecret));

    const secret = generateTotpSecret();
    const totpUri = generateTotpUri(user.email ?? user.username, secret);

    const encryptedBlob = encryptTotpSecret(secret, totpKey);
    await redisSet(
      redis,
      'totpPendingSetup',
      {
        secret,
        encryptedBlob: [...encryptedBlob],
      },
      user.id
    );

    return c.json({ totpUri, secret }, 200);
  })

  .post('/2fa/verify', zValidator('json', twoFactorVerifyRequestSchema), async (c) => {
    const { code } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    if (sessionData.pending2FA) {
      return c.json(createErrorResponse(ERROR_CODE_2FA_REQUIRED), 401);
    }

    const rateResult = await checkRateLimit(redis, 'twoFactorUserRateLimit', sessionData.userId);
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        totpEnabled: users.totpEnabled,
      })
      .from(users)
      .where(eq(users.id, sessionData.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 500);
    }

    const pendingSetupData = await redisGet(redis, 'totpPendingSetup', user.id);

    if (!pendingSetupData) {
      return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_2FA_SETUP), 400);
    }

    const pending = pendingSetupData;

    const result = await verifyTotpSetupCode({
      redis,
      userId: user.id,
      plaintextSecret: pending.secret,
      code,
      now: new Date(),
    });
    if (!result.ok) {
      return c.json(createErrorResponse(ERROR_CODE_INVALID_TOTP_CODE), 400);
    }

    // Use the encrypted blob from pending setup (UPDATE with WHERE is idempotent)
    const blob = new Uint8Array(pending.encryptedBlob);

    await db
      .update(users)
      .set({
        totpSecretEncrypted: blob,
        totpEnabled: true,
      })
      .where(eq(users.id, user.id));

    await redisDel(redis, 'totpPendingSetup', user.id);

    await sendNotificationEmail(db, c.env, user.id, (u) => ({
      subject: 'Two-factor authentication enabled',
      content: twoFactorEnabledEmail({ userName: displayUsername(u.username) }),
    }));

    return c.json({ success: true }, 200);
  })

  .post('/2fa/disable/init', zValidator('json', twoFactorDisableInitRequestSchema), async (c) => {
    const { ke1 } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const frontendUrl = c.env.FRONTEND_URL;

    if (!masterSecret || !frontendUrl) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    if (sessionData.pending2FA) {
      return c.json(createErrorResponse(ERROR_CODE_2FA_REQUIRED), 401);
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        opaqueRegistration: users.opaqueRegistration,
        totpEnabled: users.totpEnabled,
      })
      .from(users)
      .where(eq(users.id, sessionData.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 500);
    }

    if (!user.totpEnabled) {
      return c.json(createErrorResponse(ERROR_CODE_TOTP_NOT_ENABLED), 400);
    }

    let stepUp;
    try {
      stepUp = await startOpaqueStepUp({
        ke1: new Uint8Array(ke1),
        userId: user.id,
        opaqueRegistration: user.opaqueRegistration,
        username: user.id,
        masterSecret: textEncoder.encode(masterSecret),
        redis,
        redisKeyName: 'opaquePending2FADisable',
      });
    } catch {
      return c.json(createErrorResponse(ERROR_CODE_DISABLE_2FA_INIT_FAILED), 500);
    }

    return c.json(
      {
        ke2: [...stepUp.ke2],
      },
      200
    );
  })

  .post(
    '/2fa/disable/finish',
    zValidator('json', twoFactorDisableFinishRequestSchema),
    async (c) => {
      const { ke3, code } = c.req.valid('json');
      const db = c.get('db');
      const redis = c.get('redis');
      const masterSecret = c.env.OPAQUE_MASTER_SECRET;
      const frontendUrl = c.env.FRONTEND_URL;

      if (!masterSecret || !frontendUrl) {
        return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
      }

      const sessionData = c.get('sessionData');
      if (!sessionData?.userId) {
        return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
      }

      const rateResult = await checkRateLimit(redis, 'twoFactorUserRateLimit', sessionData.userId);
      if (!rateResult.allowed) {
        return c.json(
          createErrorResponse(ERROR_CODE_RATE_LIMITED, {
            retryAfterSeconds: rateResult.retryAfterSeconds,
          }),
          429
        );
      }

      const finishResult = await finishOpaqueStepUp({
        ke3: new Uint8Array(ke3),
        userId: sessionData.userId,
        redis,
        redisKeyName: 'opaquePending2FADisable',
      });
      if (!finishResult.ok) {
        if (finishResult.reason === 'no-pending') {
          return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_DISABLE), 400);
        }
        return c.json(createErrorResponse(ERROR_CODE_INCORRECT_PASSWORD), 401);
      }

      const totpUserResult = await getUserWithTotpConfig(db, sessionData.userId);
      if (!totpUserResult.found) {
        return c.json(createErrorResponse(totpUserResult.error), totpUserResult.status);
      }

      const { user } = totpUserResult;

      const result = await verifyTotpStepUp({
        redis,
        userId: user.id,
        masterSecret: textEncoder.encode(masterSecret),
        encryptedSecret: user.totpSecretEncrypted,
        code,
        now: new Date(),
      });
      if (!result.ok) {
        return c.json(createErrorResponse(ERROR_CODE_INVALID_TOTP_CODE), 400);
      }

      await db
        .update(users)
        .set({
          totpSecretEncrypted: null,
          totpEnabled: false,
        })
        .where(eq(users.id, user.id));

      await sendNotificationEmail(db, c.env, user.id, (u) => ({
        subject: 'Two-factor authentication disabled',
        content: twoFactorDisabledEmail({ userName: displayUsername(u.username) }),
      }));

      return c.json({ success: true }, 200);
    }
  )

  .post('/verify-email', zValidator('json', verifyEmailRequestSchema), async (c) => {
    const { token } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');

    const ip = getClientIp(c);
    const ipHash = hashIp(ip);

    // Rate limit by IP only (token-based rate limiting is ineffective since
    // each invalid attempt uses a different token)
    const rateResult = await checkRateLimit(redis, 'verifyIpRateLimit', ipHash);
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.emailVerifyToken, token), gt(users.emailVerifyExpires, new Date())));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_INVALID_OR_EXPIRED_TOKEN), 400);
    }

    await db
      .update(users)
      .set({
        emailVerified: true,
        emailVerifyToken: null,
        emailVerifyExpires: null,
      })
      .where(eq(users.id, user.id));

    return c.json({ success: true }, 200);
  })

  .post('/resend-verification', zValidator('json', resendVerificationRequestSchema), async (c) => {
    const { email } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');

    const ip = getClientIp(c);
    const ipHash = hashIp(ip);

    const rateResult = await checkDualRateLimit({
      redis,
      userKeyName: 'resendVerifyEmailRateLimit',
      ipKeyName: 'resendVerifyIpRateLimit',
      userIdentifier: email.toLowerCase(),
      ipHash,
    });
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()), eq(users.emailVerified, false)));

    // Don't leak existence - always return 200
    if (!user) {
      return c.json({ success: true }, 200);
    }

    const emailToken = crypto.randomUUID();
    const emailExpires = new Date(Date.now() + EMAIL_VERIFY_TOKEN_EXPIRY_MS);

    await db
      .update(users)
      .set({
        emailVerifyToken: emailToken,
        emailVerifyExpires: emailExpires,
      })
      .where(eq(users.id, user.id));

    const frontendUrl = c.env.FRONTEND_URL;
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL is required');
    }
    const verificationUrl = `${frontendUrl}/verify?token=${emailToken}`;

    try {
      const emailClient = getEmailClient(c.env);
      const content = verificationEmail({
        userName: displayUsername(user.username),
        verificationUrl,
      });
      await emailClient.sendEmail({
        to: email.toLowerCase(),
        subject: 'Verify your email address',
        html: content.html,
        text: content.text,
      });
    } catch {
      // Email send failure should not block response
    }

    return c.json({ success: true }, 200);
  })

  .post('/change-password/init', zValidator('json', changePasswordInitRequestSchema), async (c) => {
    const { ke1, newRegistrationRequest } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const frontendUrl = c.env.FRONTEND_URL;

    if (!masterSecret || !frontendUrl) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        opaqueRegistration: users.opaqueRegistration,
      })
      .from(users)
      .where(eq(users.id, sessionData.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 500);
    }

    let stepUp;
    try {
      stepUp = await startOpaqueStepUp({
        ke1: new Uint8Array(ke1),
        userId: user.id,
        opaqueRegistration: user.opaqueRegistration,
        username: user.id,
        masterSecret: textEncoder.encode(masterSecret),
        redis,
        redisKeyName: 'opaquePendingChangePassword',
      });
    } catch {
      return c.json(createErrorResponse(ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED), 500);
    }

    const opaqueServer = await createOpaqueServerFromEnv(masterSecret);
    const regRequest = RegistrationRequest.deserialize(OpaqueServerConfig, newRegistrationRequest);
    const newRegResult = await opaqueServer.registerInit(regRequest, user.id);
    if (newRegResult instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_CHANGE_PASSWORD_REG_FAILED), 500);
    }

    return c.json(
      {
        ke2: [...stepUp.ke2],
        newRegistrationResponse: newRegResult.serialize(),
      },
      200
    );
  })

  .post(
    '/change-password/finish',
    zValidator('json', changePasswordFinishRequestSchema),
    async (c) => {
      const { ke3, newRegistrationRecord, newPasswordWrappedPrivateKey } = c.req.valid('json');
      const db = c.get('db');
      const redis = c.get('redis');
      const masterSecret = c.env.OPAQUE_MASTER_SECRET;
      const frontendUrl = c.env.FRONTEND_URL;

      if (!masterSecret || !frontendUrl) {
        return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
      }

      const sessionData = c.get('sessionData');
      if (!sessionData?.userId) {
        return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
      }

      const finishResult = await finishOpaqueStepUp({
        ke3: new Uint8Array(ke3),
        userId: sessionData.userId,
        redis,
        redisKeyName: 'opaquePendingChangePassword',
      });
      if (!finishResult.ok) {
        if (finishResult.reason === 'no-pending') {
          return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_CHANGE), 400);
        }
        return c.json(createErrorResponse(ERROR_CODE_INCORRECT_PASSWORD), 401);
      }

      const newRecord = RegistrationRecord.deserialize(OpaqueServerConfig, newRegistrationRecord);
      const newRecordBytes = new Uint8Array(newRecord.serialize());

      const newPasswordWrappedPrivateKeyBytes = fromBase64(newPasswordWrappedPrivateKey);

      // ATOMIC UPDATE: update all fields in one operation
      await db
        .update(users)
        .set({
          opaqueRegistration: newRecordBytes,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKeyBytes,
        })
        .where(eq(users.id, sessionData.userId));

      // Revoke all sessions for this user (except current)
      await redisSet(redis, 'passwordChangedAt', Date.now(), sessionData.userId);

      await sendNotificationEmail(db, c.env, sessionData.userId, (u) => ({
        subject: 'Your password was changed',
        content: passwordChangedEmail({ userName: displayUsername(u.username) }),
      }));

      return c.json({ success: true }, 200);
    }
  )

  .post('/recovery/reset', zValidator('json', recoveryResetRequestSchema), async (c) => {
    const { identifier, newRegistrationRequest } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const frontendUrl = c.env.FRONTEND_URL;

    if (!masterSecret || !frontendUrl) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const ip = getClientIp(c);
    const ipHash = hashIp(ip);
    const rateResult = await checkDualRateLimit({
      redis,
      userKeyName: 'recoveryUserRateLimit',
      ipKeyName: 'recoveryIpRateLimit',
      userIdentifier: identifier.toLowerCase(),
      ipHash,
    });
    if (!rateResult.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: rateResult.retryAfterSeconds,
        }),
        429
      );
    }

    // Look up user by email or username to use their ID as OPAQUE credential identifier
    const lookupCondition = resolveIdentifierCondition(identifier);
    const [existingUser] = await db.select({ id: users.id }).from(users).where(lookupCondition);

    const opaqueServer = await createOpaqueServerFromEnv(masterSecret);

    const request = RegistrationRequest.deserialize(OpaqueServerConfig, newRegistrationRequest);
    const credentialIdentifier = existingUser?.id ?? crypto.randomUUID();

    const result = await opaqueServer.registerInit(request, credentialIdentifier);
    if (result instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_REGISTRATION_FAILED), 500);
    }

    await redisSet(
      redis,
      'opaquePendingRecoveryReset',
      { identifier: identifier.toLowerCase() },
      identifier.toLowerCase()
    );

    return c.json({ newRegistrationResponse: result.serialize() }, 200);
  })

  .post(
    '/recovery/reset/finish',
    zValidator('json', recoveryResetFinishRequestSchema),
    async (c) => {
      const { identifier, newRegistrationRecord, newPasswordWrappedPrivateKey } =
        c.req.valid('json');
      const db = c.get('db');
      const redis = c.get('redis');

      const pendingData = await redisGet(
        redis,
        'opaquePendingRecoveryReset',
        identifier.toLowerCase()
      );
      if (!pendingData) {
        return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_RECOVERY), 400);
      }

      const lookupCondition = resolveIdentifierCondition(identifier);
      const [user] = await db.select({ id: users.id }).from(users).where(lookupCondition);

      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_RECOVERY), 400);
      }

      const record = RegistrationRecord.deserialize(OpaqueServerConfig, newRegistrationRecord);
      const recordBytes = new Uint8Array(record.serialize());

      const newPasswordWrappedPrivateKeyBytes = fromBase64(newPasswordWrappedPrivateKey);

      await db
        .update(users)
        .set({
          opaqueRegistration: recordBytes,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKeyBytes,
        })
        .where(eq(users.id, user.id));

      await redisDel(redis, 'opaquePendingRecoveryReset', identifier.toLowerCase());

      await redisSet(redis, 'passwordChangedAt', Date.now(), user.id);

      await sendNotificationEmail(db, c.env, user.id, (u) => ({
        subject: 'Your password was reset',
        content: passwordChangedEmail({ userName: displayUsername(u.username) }),
      }));

      return c.json({ success: true }, 200);
    }
  )

  .post(
    '/recovery/get-wrapped-key',
    zValidator('json', recoveryGetWrappedKeyRequestSchema),
    async (c) => {
      const { identifier } = c.req.valid('json');
      const db = c.get('db');
      const redis = c.get('redis');

      const ip = getClientIp(c);
      const ipHash = hashIp(ip);
      const rateResult = await checkDualRateLimit({
        redis,
        userKeyName: 'recoveryGetKeyUserRateLimit',
        ipKeyName: 'recoveryGetKeyIpRateLimit',
        userIdentifier: identifier.toLowerCase(),
        ipHash,
      });
      if (!rateResult.allowed) {
        return c.json(
          createErrorResponse(ERROR_CODE_RATE_LIMITED, {
            retryAfterSeconds: rateResult.retryAfterSeconds,
          }),
          429
        );
      }

      const lookupCondition = resolveIdentifierCondition(identifier);
      const [user] = await db
        .select({ recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey })
        .from(users)
        .where(lookupCondition);

      if (user) {
        return c.json({ recoveryWrappedPrivateKey: toBase64(user.recoveryWrappedPrivateKey) }, 200);
      }

      // User not found: return dummy value (timing-safe, don't reveal whether identifier exists)
      return c.json({ recoveryWrappedPrivateKey: toBase64(new Uint8Array(128)) }, 200);
    }
  )

  .post('/recovery/save', zValidator('json', recoverySaveRequestSchema), async (c) => {
    const { recoveryWrappedPrivateKey } = c.req.valid('json');
    const db = c.get('db');

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    if (sessionData.pending2FA) {
      return c.json(createErrorResponse(ERROR_CODE_2FA_REQUIRED), 401);
    }

    let recoveryWrappedPrivateKeyBytes: Uint8Array;

    try {
      recoveryWrappedPrivateKeyBytes = fromBase64(recoveryWrappedPrivateKey);
    } catch {
      return c.json(createErrorResponse(ERROR_CODE_INVALID_BASE64), 400);
    }

    await db
      .update(users)
      .set({
        recoveryWrappedPrivateKey: recoveryWrappedPrivateKeyBytes,
        hasAcknowledgedPhrase: true,
      })
      .where(eq(users.id, sessionData.userId));

    return c.json({ success: true }, 200);
  });
