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
  getServerIdentifier,
  OpaqueServerConfig,
} from '@hushbox/crypto';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv, Bindings } from '../types.js';
import { getSessionOptions, type SessionData } from '../lib/session.js';
import {
  generateTotpSecret,
  generateTotpUri,
  encryptTotpSecret,
  deriveTotpEncryptionKey,
  decryptTotpSecret,
  verifyTotpWithReplayProtection,
} from '../lib/totp.js';
import {
  checkRateLimit,
  checkDualRateLimit,
  recordFailedAttempt,
  isLockedOut,
  clearLockout,
} from '../lib/rate-limit.js';
import { getClientIp, hashIp } from '../lib/client-ip.js';
import { redisGet, redisSet, redisDel, REDIS_REGISTRY } from '../lib/redis-registry.js';
import { getEmailClient } from '../services/email/index.js';
import { ensureWalletsExist } from '../services/billing/wallet-provisioning.js';
import {
  verificationEmail,
  passwordChangedEmail,
  twoFactorEnabledEmail,
  twoFactorDisabledEmail,
  accountLockedEmail,
} from '../services/email/templates/index.js';
import { EMAIL_VERIFY_TOKEN_EXPIRY_MS } from '../constants/auth.js';

const PENDING_2FA_LOGIN_SECONDS = 5 * 60; // 5 minutes

/**
 * Helper function to decrypt and verify TOTP code with replay protection.
 * Decrypts the TOTP secret and verifies the code against Redis replay protection.
 */
async function decryptAndVerifyTotp(options: {
  redis: import('@upstash/redis').Redis;
  masterSecret: string;
  userId: string;
  code: string;
  totpSecretEncrypted: number[] | Uint8Array;
}): Promise<{ valid: true } | { valid: false; error: string }> {
  const totpKey = deriveTotpEncryptionKey(textEncoder.encode(options.masterSecret));
  const blob =
    options.totpSecretEncrypted instanceof Uint8Array
      ? options.totpSecretEncrypted
      : new Uint8Array(options.totpSecretEncrypted);
  const secret = decryptTotpSecret(blob, totpKey);
  const result = await verifyTotpWithReplayProtection(
    options.redis,
    options.userId,
    options.code,
    secret
  );
  if (!result.valid) {
    return { valid: false, error: result.error ?? ERROR_CODE_INVALID_TOTP_CODE };
  }
  return { valid: true };
}

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

// Schema definitions
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

// NOTE: recovery/request-salt and recovery/verify-phrase are deprecated (Phase 3E).
// The new recovery flow uses recoveryWrappedPrivateKey stored during registration.
// These endpoints are kept as stubs returning errors until Phase 3E removes them.

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

  // POST /register/init - Start OPAQUE registration
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

    // Check if email already exists
    const existingUser = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    const userExists = existingUser.length > 0;

    // Pre-generate user ID for OPAQUE credential identifier
    const userId = crypto.randomUUID();

    // Create OPAQUE server and process registration request
    // Always process request to prevent user enumeration
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

    const request = RegistrationRequest.deserialize(OpaqueServerConfig, registrationRequest);
    const credentialIdentifier = userId;

    const result = await opaqueServer.registerInit(request, credentialIdentifier);
    if (result instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_REGISTRATION_FAILED), 500);
    }

    // Store pending registration data in Redis with existing flag if user exists
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

  // POST /register/finish - Complete OPAQUE registration
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

    // Check for pending registration
    const pendingData = await redisGet(redis, 'opaquePendingRegistration', email);
    if (!pendingData) {
      return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_REGISTRATION), 400);
    }

    const pending = pendingData;

    // If this is a fake registration for an existing user, skip DB insert
    if (pending.existing) {
      // Clean up pending registration
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

    // Deserialize and validate the registration record
    const record = RegistrationRecord.deserialize(OpaqueServerConfig, registrationRecord);
    const recordBytes = new Uint8Array(record.serialize());

    // Decode base64 key material
    const publicKeyBytes = fromBase64(accountPublicKey);
    const passwordWrappedPrivateKeyBytes = fromBase64(passwordWrappedPrivateKey);
    const recoveryWrappedPrivateKeyBytes = fromBase64(recoveryWrappedPrivateKey);

    // Create user in database with pre-generated ID (unique email constraint prevents duplicates - idempotent)
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

    const newUser = result[0];
    if (!newUser) {
      return c.json(createErrorResponse(ERROR_CODE_USER_CREATION_FAILED), 500);
    }

    // Provision wallets (purchased with welcome credit + free tier with daily allowance)
    await ensureWalletsExist(db, newUser.id);

    // Clean up pending registration
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

  // POST /login/init - Start OPAQUE login
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
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);
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
      const serverIdentifier = getServerIdentifier(frontendUrl);
      const fake = await createFakeRegistrationRecord(masterSecretBytes, serverIdentifier);
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

  // POST /login/finish - Complete OPAQUE login, set iron-session
  .post('/login/finish', zValidator('json', loginFinishRequestSchema), async (c) => {
    const { identifier, ke3 } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const authEnv = getAuthEnvWithSession(c.env);
    if (!authEnv) return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    const { masterSecret, frontendUrl, sessionSecret } = authEnv;

    // Check for pending login
    const pendingData = await redisGet(redis, 'opaquePendingLogin', identifier);
    if (!pendingData) {
      return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_LOGIN), 400);
    }

    const pending = pendingData;

    // Create OPAQUE server and verify KE3
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

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

    // Get user data for response
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

    // Clean up pending login
    await redisDel(redis, 'opaquePendingLogin', identifier);

    // Clear lockout on successful login
    await clearLockout(redis, 'loginLockout', user.id, 'loginUserRateLimit');

    // Set iron-session cookie
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

  // POST /login/2fa/verify - Verify TOTP during login flow
  .post('/login/2fa/verify', zValidator('json', login2FAVerifyRequestSchema), async (c) => {
    const { code } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const sessionSecret = c.env.IRON_SESSION_SECRET;

    if (!sessionSecret || !masterSecret) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    // Read iron-session from cookie
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

    // Rate limiting for 2FA
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

    // Get user and verify TOTP
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

    const result = await decryptAndVerifyTotp({
      redis,
      masterSecret,
      userId: sessionCheck.userId,
      code,
      totpSecretEncrypted: userRow.totpSecretEncrypted,
    });
    if (!result.valid) {
      await recordFailedAttempt(
        redis,
        'twoFactorUserRateLimit',
        sessionCheck.userId,
        'twoFactorLockout'
      );
      return c.json(createErrorResponse(result.error), 400);
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

    // Clear 2FA lockout on success
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

  // GET /me - Get current authenticated user data + wrapped account key
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
      },
      200
    );
  })

  // POST /logout - Clear session (idempotent — succeeds even without a session)
  .post('/logout', async (c) => {
    const sessionSecret = c.env.IRON_SESSION_SECRET;
    if (!sessionSecret) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json({ success: true }, 200);
    }

    // Clean up session from Redis
    const redis = c.get('redis');
    await redisDel(redis, 'sessionActive', sessionData.userId, sessionData.sessionId);

    // Get writable session and destroy it
    const { isProduction: isProductionLogout } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(sessionSecret, isProductionLogout)
    );
    session.destroy();

    return c.json({ success: true }, 200);
  })

  // POST /2fa/setup - Initiate 2FA setup (authenticated, non-pending)
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

    // Check if 2FA is already enabled
    if (user.totpEnabled) {
      return c.json(createErrorResponse(ERROR_CODE_TOTP_ALREADY_ENABLED), 400);
    }

    const totpKey = deriveTotpEncryptionKey(textEncoder.encode(masterSecret));

    // Generate new TOTP secret
    const secret = generateTotpSecret();
    const totpUri = generateTotpUri(user.email ?? user.username, secret);

    // Encrypt and store pending 2FA setup in Redis
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

  // POST /2fa/verify - Verify TOTP code and enable 2FA (setup flow)
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

    // Rate limiting
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

    // Check for pending 2FA setup
    const pendingSetupData = await redisGet(redis, 'totpPendingSetup', user.id);

    if (!pendingSetupData) {
      return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_2FA_SETUP), 400);
    }

    const pending = pendingSetupData;

    const result = await verifyTotpWithReplayProtection(redis, user.id, code, pending.secret);
    if (!result.valid) {
      return c.json(createErrorResponse(result.error ?? ERROR_CODE_INVALID_TOTP_CODE), 400);
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

    // Clean up pending setup
    await redisDel(redis, 'totpPendingSetup', user.id);

    // Send 2FA enabled notification email (fire-and-forget)
    await sendNotificationEmail(db, c.env, user.id, (u) => ({
      subject: 'Two-factor authentication enabled',
      content: twoFactorEnabledEmail({ userName: displayUsername(u.username) }),
    }));

    return c.json({ success: true }, 200);
  })

  // POST /2fa/disable/init - Initiate 2FA disable with password verification
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

    // Get user with OPAQUE registration
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

    // Create OPAQUE server and process login init
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

    const registrationRecord = RegistrationRecord.deserialize(OpaqueServerConfig, [
      ...user.opaqueRegistration,
    ]);

    const ke1Message = KE1.deserialize(OpaqueServerConfig, ke1);
    const credentialIdentifier = user.id;

    const loginResult = await opaqueServer.authInit(
      ke1Message,
      registrationRecord,
      credentialIdentifier
    );
    if (loginResult instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_DISABLE_2FA_INIT_FAILED), 500);
    }

    const { ke2, expected } = loginResult;

    // Store pending state in Redis
    await redisSet(
      redis,
      'opaquePending2FADisable',
      {
        userId: user.id,
        expectedSerialized: expected.serialize(),
      },
      user.id
    );

    return c.json(
      {
        ke2: ke2.serialize(),
      },
      200
    );
  })

  // POST /2fa/disable/finish - Complete 2FA disable with password verification
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

      // Rate limiting
      const rateResult = await checkRateLimit(redis, 'twoFactorUserRateLimit', sessionData.userId);
      if (!rateResult.allowed) {
        return c.json(
          createErrorResponse(ERROR_CODE_RATE_LIMITED, {
            retryAfterSeconds: rateResult.retryAfterSeconds,
          }),
          429
        );
      }

      // Get pending state
      const pendingData = await redisGet(redis, 'opaquePending2FADisable', sessionData.userId);
      if (!pendingData) {
        return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_DISABLE), 400);
      }

      // Verify password with OPAQUE
      const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

      const ke3Message = KE3.deserialize(OpaqueServerConfig, ke3);
      const expected = ExpectedAuthResult.deserialize(
        OpaqueServerConfig,
        pendingData.expectedSerialized
      );

      const authResult = opaqueServer.authFinish(ke3Message, expected);
      if (authResult instanceof Error) {
        await redisDel(redis, 'opaquePending2FADisable', sessionData.userId);
        return c.json(createErrorResponse(ERROR_CODE_INCORRECT_PASSWORD), 401);
      }

      // Clean up pending state
      await redisDel(redis, 'opaquePending2FADisable', sessionData.userId);

      // Verify TOTP code
      const totpUserResult = await getUserWithTotpConfig(db, sessionData.userId);
      if (!totpUserResult.found) {
        return c.json(createErrorResponse(totpUserResult.error), totpUserResult.status);
      }

      const { user } = totpUserResult;

      const result = await decryptAndVerifyTotp({
        redis,
        masterSecret,
        userId: user.id,
        code,
        totpSecretEncrypted: user.totpSecretEncrypted,
      });
      if (!result.valid) {
        return c.json(createErrorResponse(result.error), 400);
      }

      // Disable 2FA
      await db
        .update(users)
        .set({
          totpSecretEncrypted: null,
          totpEnabled: false,
        })
        .where(eq(users.id, user.id));

      // Send 2FA disabled notification email (fire-and-forget)
      await sendNotificationEmail(db, c.env, user.id, (u) => ({
        subject: 'Two-factor authentication disabled',
        content: twoFactorDisabledEmail({ userName: displayUsername(u.username) }),
      }));

      return c.json({ success: true }, 200);
    }
  )

  // POST /verify-email - Verify email address with token
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

    // Look up user by token
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.emailVerifyToken, token), gt(users.emailVerifyExpires, new Date())));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_INVALID_OR_EXPIRED_TOKEN), 400);
    }

    // Verify email
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

  // POST /resend-verification - Resend verification email
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

    // Look up user by email WHERE emailVerified = false
    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()), eq(users.emailVerified, false)));

    // Don't leak existence - always return 200
    if (!user) {
      return c.json({ success: true }, 200);
    }

    // Generate new token
    const emailToken = crypto.randomUUID();
    const emailExpires = new Date(Date.now() + EMAIL_VERIFY_TOKEN_EXPIRY_MS);

    await db
      .update(users)
      .set({
        emailVerifyToken: emailToken,
        emailVerifyExpires: emailExpires,
      })
      .where(eq(users.id, user.id));

    // Send verification email
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

  // POST /change-password/init - Initiate password change (authenticated)
  // Processes both: OPAQUE login for old password verification + OPAQUE registration for new password
  .post('/change-password/init', zValidator('json', changePasswordInitRequestSchema), async (c) => {
    const { ke1, newRegistrationRequest } = c.req.valid('json');
    const db = c.get('db');
    const redis = c.get('redis');
    const masterSecret = c.env.OPAQUE_MASTER_SECRET;
    const frontendUrl = c.env.FRONTEND_URL;

    if (!masterSecret || !frontendUrl) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    // Require session
    const sessionData = c.get('sessionData');
    if (!sessionData?.userId) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
    }

    // Get user
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

    // Create OPAQUE server
    const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

    // 1. Process OPAQUE login init (verify old password)
    const registrationRecord = RegistrationRecord.deserialize(OpaqueServerConfig, [
      ...user.opaqueRegistration,
    ]);

    const ke1Message = KE1.deserialize(OpaqueServerConfig, ke1);
    const credentialIdentifier = user.id;

    const loginResult = await opaqueServer.authInit(
      ke1Message,
      registrationRecord,
      credentialIdentifier
    );
    if (loginResult instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED), 500);
    }

    const { ke2, expected } = loginResult;

    // 2. Process OPAQUE registration init (new password)
    const regRequest = RegistrationRequest.deserialize(OpaqueServerConfig, newRegistrationRequest);
    const newRegResult = await opaqueServer.registerInit(regRequest, credentialIdentifier);
    if (newRegResult instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_CHANGE_PASSWORD_REG_FAILED), 500);
    }

    // Store pending state in Redis
    await redisSet(
      redis,
      'opaquePendingChangePassword',
      {
        userId: user.id,
        expectedSerialized: expected.serialize(),
      },
      user.id
    );

    return c.json(
      {
        ke2: ke2.serialize(),
        newRegistrationResponse: newRegResult.serialize(),
      },
      200
    );
  })

  // POST /change-password/finish - Complete password change (authenticated)
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

      // Require session
      const sessionData = c.get('sessionData');
      if (!sessionData?.userId) {
        return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
      }

      // Get pending state
      const pendingData = await redisGet(redis, 'opaquePendingChangePassword', sessionData.userId);
      if (!pendingData) {
        return c.json(createErrorResponse(ERROR_CODE_NO_PENDING_CHANGE), 400);
      }

      const pending = pendingData;

      // Verify old password with OPAQUE
      const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

      const ke3Message = KE3.deserialize(OpaqueServerConfig, ke3);
      const expected = ExpectedAuthResult.deserialize(
        OpaqueServerConfig,
        pending.expectedSerialized
      );

      const authResult = opaqueServer.authFinish(ke3Message, expected);
      if (authResult instanceof Error) {
        await redisDel(redis, 'opaquePendingChangePassword', sessionData.userId);
        return c.json(createErrorResponse(ERROR_CODE_INCORRECT_PASSWORD), 401);
      }

      // Deserialize new registration record
      const newRecord = RegistrationRecord.deserialize(OpaqueServerConfig, newRegistrationRecord);
      const newRecordBytes = new Uint8Array(newRecord.serialize());

      // Decode base64 field
      const newPasswordWrappedPrivateKeyBytes = fromBase64(newPasswordWrappedPrivateKey);

      // ATOMIC UPDATE: update all fields in one operation
      await db
        .update(users)
        .set({
          opaqueRegistration: newRecordBytes,
          passwordWrappedPrivateKey: newPasswordWrappedPrivateKeyBytes,
        })
        .where(eq(users.id, sessionData.userId));

      // Clean up pending state
      await redisDel(redis, 'opaquePendingChangePassword', sessionData.userId);

      // Revoke all sessions for this user (except current)
      await redisSet(redis, 'passwordChangedAt', Date.now(), sessionData.userId);

      // Send password changed notification email (fire-and-forget)
      await sendNotificationEmail(db, c.env, sessionData.userId, (u) => ({
        subject: 'Your password was changed',
        content: passwordChangedEmail({ userName: displayUsername(u.username) }),
      }));

      return c.json({ success: true }, 200);
    }
  )

  // POST /recovery/reset - Start OPAQUE re-registration for recovery
  // New flow: client enters mnemonic locally, unwraps account key, then re-registers OPAQUE
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

    const opaqueServer = await createOpaqueServerFromEnv(masterSecret, frontendUrl);

    const request = RegistrationRequest.deserialize(OpaqueServerConfig, newRegistrationRequest);
    const credentialIdentifier = existingUser?.id ?? crypto.randomUUID();

    const result = await opaqueServer.registerInit(request, credentialIdentifier);
    if (result instanceof Error) {
      return c.json(createErrorResponse(ERROR_CODE_REGISTRATION_FAILED), 500);
    }

    // Store pending recovery state in Redis
    await redisSet(
      redis,
      'opaquePendingRecoveryReset',
      { identifier: identifier.toLowerCase() },
      identifier.toLowerCase()
    );

    return c.json({ newRegistrationResponse: result.serialize() }, 200);
  })

  // POST /recovery/reset/finish - Complete password reset via recovery
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

      // Find user by email or username
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

      // Send password reset notification email (fire-and-forget)
      await sendNotificationEmail(db, c.env, user.id, (u) => ({
        subject: 'Your password was reset',
        content: passwordChangedEmail({ userName: displayUsername(u.username) }),
      }));

      return c.json({ success: true }, 200);
    }
  )

  // POST /recovery/get-wrapped-key - Return recoveryWrappedPrivateKey for recovery flow
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

  // POST /recovery/save - Save new recovery wrapped private key (authenticated)
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
