import { afterAll, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { eq, like } from 'drizzle-orm';
import { unsealData } from 'iron-session';
import { LOCAL_NEON_DEV_CONFIG, accountDeletionEvents, createDb, users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateAccountKeyPair,
  generateTotpCodeSync,
  rewrapAccountKeyForPasswordChange,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES, TERMS_OF_SERVICE_REVISION, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { routeClass } from '../../middleware/pipeline-markers.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import {
  BILLING_PORTAL_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  bindRequestValue,
  parseBillingPortalClaims,
  parseSessionClaims,
} from '../../lib/context/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { scrubSentryEvent } from '../../lib/telemetry/adapters/sentry-scrub.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  checkBillingPortalRevocation,
  checkSessionRevocation,
  createIdentityManifest,
  createIdentityStores,
  issueBillingPortalCredential,
} from './index.js';
import { createBillingStores } from '../billing/index.js';
import { createGrowthStores } from '../growth/index.js';
import { createAppJobRegistry, enqueueWithinTx } from '../../lib/jobs/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE, createMediaReclaimUserJob } from '../media/index.js';
import {
  captureContentStorageKeysWithinTx,
  deleteForeignMessageContentWithinTx,
  detachMessageSendersWithinTx,
} from '../chat/index.js';
import type { Storage } from '../media/index.js';
import type { WelcomeEmailPort } from '../billing/index.js';
import type { ExecutionContext } from 'hono';
import type {
  AppEnv,
  BillingPortalClaims,
  Bindings,
  SessionClaims,
} from '../../lib/context/index.js';
import type { Telemetry, TelemetryEnv } from '../../lib/telemetry/index.js';
import type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  IdentityRouteDeps,
  PasswordChangedEmailPort,
  PasswordResetEmailPort,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  VerificationEmailPort,
} from './index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
const OPAQUE_KEK = process.env['OPAQUE_KEK'];
const TOTP_ENCRYPTION_SECRET = process.env['TOTP_ENCRYPTION_SECRET'];
const ENUMERATION_DECOY_SECRET = process.env['ENUMERATION_DECOY_SECRET'];
if (
  !DATABASE_URL ||
  !UPSTASH_REDIS_REST_URL ||
  !UPSTASH_REDIS_REST_TOKEN ||
  !OPAQUE_KEK ||
  !TOTP_ENCRYPTION_SECRET ||
  !ENUMERATION_DECOY_SECRET
) {
  throw new Error(
    'DATABASE_URL, Upstash vars, OPAQUE_KEK, TOTP_ENCRYPTION_SECRET and ENUMERATION_DECOY_SECRET are required'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';

export const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  OPAQUE_KEK,
  TOTP_ENCRYPTION_SECRET,
  ENUMERATION_DECOY_SECRET,
  GROWTH_HASH_SECRET: 'a-growth-hash-secret-of-at-least-32-chars',
  TELEMETRY_SINKS: 'console',
};

export const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
export const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** Records verification-email sends so the resend suite can assert on them. */
export const sentVerifications: { to: string; token: string; userName?: string }[] = [];
/**
 * When `shouldFail` is set, the verification port errs — exercises the
 * best-effort swallow in resend. A mutable holder (not a bare `let`) so tests
 * across the split files can toggle it through the imported binding.
 */
export const emailPortFailure = { shouldFail: false };
const emailPort: VerificationEmailPort = {
  sendVerificationEmail: (args) => {
    sentVerifications.push({
      to: args.to,
      token: args.token,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return emailPortFailure.shouldFail
      ? errAsync(unavailableError('email sender down'))
      : okAsync();
  },
};

/** Records password-changed notification sends so the rotation suites can assert on them. */
export const sentPasswordChanged: { to: string; userName?: string }[] = [];
const passwordChangedEmailPort: PasswordChangedEmailPort = {
  sendPasswordChangedEmail: (args) => {
    sentPasswordChanged.push({
      to: args.to,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return okAsync();
  },
};

/** Records password-reset notification sends so the recovery-reset suite can assert on them. */
export const sentPasswordReset: { to: string; userName?: string }[] = [];
const passwordResetEmailPort: PasswordResetEmailPort = {
  sendPasswordResetEmail: (args) => {
    sentPasswordReset.push({
      to: args.to,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return okAsync();
  },
};

/** Records security-notification sends so the provisioning + 2FA + lockout suites can assert. */
export const sentWelcome: { to: string; userName?: string }[] = [];
const welcomeEmailPort: WelcomeEmailPort = {
  sendWelcomeEmail: (args) => {
    sentWelcome.push({
      to: args.to,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return okAsync();
  },
};
export const sentTwoFactorEnabled: { to: string }[] = [];
const twoFactorEnabledEmailPort: TwoFactorEnabledEmailPort = {
  sendTwoFactorEnabledEmail: (args) => {
    sentTwoFactorEnabled.push({ to: args.to });
    return okAsync();
  },
};
export const sentTwoFactorDisabled: { to: string }[] = [];
/**
 * When `shouldFail` is set, the disabled-email port errs — exercises the
 * best-effort swallow. A mutable holder so the split 2FA file can toggle it.
 */
export const disabledEmailFailure = { shouldFail: false };
const twoFactorDisabledEmailPort: TwoFactorDisabledEmailPort = {
  sendTwoFactorDisabledEmail: (args) => {
    sentTwoFactorDisabled.push({ to: args.to });
    return disabledEmailFailure.shouldFail
      ? errAsync(unavailableError('disabled-email sender down'))
      : okAsync();
  },
};
export const sentAccountLocked: { to: string; lockoutMinutes: number }[] = [];
/**
 * When `shouldFail` is set, the account-locked port errs — exercises the
 * best-effort swallow, which must leave the login response untouched.
 */
export const accountLockedFailure = { shouldFail: false };
const accountLockedEmailPort: AccountLockedEmailPort = {
  sendAccountLockedEmail: (args) => {
    sentAccountLocked.push({ to: args.to, lockoutMinutes: args.lockoutMinutes });
    return accountLockedFailure.shouldFail
      ? errAsync(unavailableError('account-locked sender down'))
      : okAsync();
  },
};

/** Billing's real single-writer stores — registration provisions through them. */
export const billingStores = createBillingStores();

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, so the next file to land on that slot sees whatever rows this one
 * leaves behind.
 */
export const PREFIX = `zr${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
let counter = 0;

export function uniqueAccount(): { email: string; username: string; password: string } {
  counter += 1;
  const name = `${PREFIX}a${String(counter)}`;
  return {
    email: `${name}@identity-routes.test`,
    username: name,
    password: `correct horse ${name}`,
  };
}

/**
 * Records session-revocation eviction fan-outs so the route wiring (logout,
 * 2FA-login rotation, password change, recovery reset all threading the port
 * into revocation/rotation) is observable end-to-end (ARCHITECTURE §Streaming & realtime). The
 * port's own fan-out over live rooms is exercised in app-eviction.integration.
 */
export const evictedUserIds: string[] = [];
const recordingEvictUser = (): { evictUser(userId: string): Promise<void> } => ({
  evictUser: (userId: string) => {
    evictedUserIds.push(userId);
    return Promise.resolve();
  },
});

/** Records account-deleted confirmations (sent to the pre-capture email). */
export const sentAccountDeleted: { to: string }[] = [];
const accountDeletedEmailPort: AccountDeletedEmailPort = {
  sendAccountDeletedEmail: (args) => {
    sentAccountDeleted.push({ to: args.to });
    return okAsync();
  },
};

/**
 * Enqueue-only reclaim registry: the handler runs in the dispatcher DO, never
 * in these tests — the enqueue path reads only schema/lease/shard metadata.
 */
const reclaimRegistry = createAppJobRegistry([
  createMediaReclaimUserJob({ resolveStorage: () => ({}) as Storage }),
]);

/** The real cross-slice purge, exactly as app.ts composes it. */
export const deletionPurge: AccountDeletionPurge = {
  captureContentStorageKeysWithinTx,
  deleteForeignMessageContentWithinTx,
  detachMessageSendersWithinTx,
  enqueueMediaReclaimWithinTx: async (tx, args) => {
    await enqueueWithinTx(tx, reclaimRegistry, {
      type: MEDIA_RECLAIM_USER_JOB_TYPE,
      payload: args,
    });
  },
};

export const manifestDeps: IdentityRouteDeps = {
  stores: createIdentityStores,
  emailPort,
  passwordChangedEmailPort,
  passwordResetEmailPort,
  billingStores,
  welcomeEmailPort,
  twoFactorEnabledEmailPort,
  twoFactorDisabledEmailPort,
  accountLockedEmailPort,
  evictUser: recordingEvictUser,
  growthStores: createGrowthStores(),
  accountDeletedEmailPort,
  deletionPurge: () => deletionPurge,
};

export function createApp(
  deps: IdentityRouteDeps = manifestDeps,
  onCapture?: (error: Error, errorCode: string) => void
): Hono<AppEnv> {
  const manifest = createIdentityManifest(deps);
  const app = applyPipeline(new Hono<AppEnv>(), {
    session: {
      revocation: checkSessionRevocation,
      billingRevocation: checkBillingPortalRevocation,
    },
    cache: { policies: {} },
  });
  if (onCapture !== undefined) {
    // Registered after the pipeline, which is what sets `logger`, and before
    // the routes, so every handler below sees the wrapped port.
    app.use(async (c, next) => {
      const logger = c.var.logger;
      const captureError: Telemetry['captureError'] = (error, errorCode) => {
        onCapture(error, errorCode);
        logger.captureError(error, errorCode);
      };
      bindRequestValue(c, 'logger', { ...logger, captureError });
      await next();
    });
  }
  app.route(manifest.basePath, manifest.routes);
  // Fixture routes — one per authenticated route class, so revocation and
  // principal-kind enforcement is observable across the whole matrix. The
  // pending-2fa fixture mirrors the future verify route's principal gate.
  app.get('/t/session', routeClass('session'), (c) => c.json({ kind: c.var.principal.kind }));
  app.get('/t/billing', routeClass('billing-token'), (c) => c.json({ kind: c.var.principal.kind }));
  app.get('/t/pending', routeClass('pending-2fa'), (c) =>
    c.var.principal.kind === 'pending-2fa'
      ? c.json({ kind: c.var.principal.kind })
      : c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401)
  );
  return app;
}

interface PostOptions {
  readonly app?: Hono<AppEnv>;
  readonly headers?: Record<string, string>;
  readonly executionCtx?: ExecutionContext;
  /** Bindings for this one request, when a test needs a deployment other than `testEnv`'s. */
  readonly env?: Bindings & TelemetryEnv;
}

export async function post(
  path: string,
  body: unknown,
  cookie?: string,
  options: PostOptions = {}
): Promise<Response> {
  return (options.app ?? createApp()).request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...options.headers,
      },
      body: JSON.stringify(body),
    },
    options.env ?? testEnv,
    options.executionCtx
  );
}

export async function patch(path: string, body: unknown, cookie?: string): Promise<Response> {
  return createApp().request(
    path,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

export async function get(path: string, cookie?: string): Promise<Response> {
  return createApp().request(path, { headers: cookie === undefined ? {} : { cookie } }, testEnv);
}

export async function expectStatus(pending: Promise<Response>, status: number): Promise<void> {
  const res = await pending;
  expect(res.status).toBe(status);
}

/** The allowlisted fields an error-level telemetry line can carry, as the console sink emits them. */
interface ErrorLine {
  readonly msg?: string;
  readonly errorCode?: string;
  readonly userId?: string;
  readonly route?: string;
}

/**
 * Runs one request while recording the console sink's error-level lines. The
 * console sink is what `TELEMETRY_SINKS: 'console'` composes, so its lines are
 * where a capture is observable end to end; only `captureError` writes an
 * `error.captured` line, and a log line beside it carries the safe fields.
 */
export async function recordErrorLines(
  run: () => Promise<Response>
): Promise<{ response: Response; lines: ErrorLine[] }> {
  const raw: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
    raw.push(line);
  });
  try {
    const response = await run();
    return { response, lines: raw.map((line) => JSON.parse(line) as ErrorLine) };
  } finally {
    spy.mockRestore();
  }
}

/** One `captureError` call as the Telemetry port received it. */
interface RecordedCapture {
  readonly error: Error;
  readonly errorCode: string;
}

/**
 * Runs one request through an app whose Telemetry port records the Errors
 * `captureError` receives. The console sink's line shows THAT a capture
 * happened; only the Error object shows what rides on it to the Sentry scrub,
 * which rebuilds the outgoing event from the properties that error carries and
 * from nothing else.
 */
export async function recordCaptures(
  run: (app: Hono<AppEnv>) => Promise<Response>
): Promise<{ response: Response; captures: RecordedCapture[] }> {
  const captures: RecordedCapture[] = [];
  const app = createApp(manifestDeps, (error, errorCode) => {
    captures.push({ error, errorCode });
  });
  const response = await run(app);
  return { response, captures };
}

/**
 * The tags the one recorded capture puts on the wire, having asserted there was
 * one: the captured error run through the Sentry scrub, which rebuilds the
 * outgoing event from an allowlist over the error's own properties. Sentry is
 * the sole channel a deployment retains, so this — not the console line beside
 * it — is what an operator is paged with.
 */
export function scrubbedCaptureTags(captures: readonly RecordedCapture[]): Record<string, unknown> {
  expect(captures).toHaveLength(1);
  const capture = captures[0];
  const scrubbed = scrubSentryEvent(
    { type: undefined, tags: { errorCode: capture?.errorCode } },
    { originalException: capture?.error }
  );
  return scrubbed?.tags ?? {};
}

const accountKeyPair = generateAccountKeyPair();
const recoveryKeyPair = generateAccountKeyPair();

/**
 * The phrase-holder's half of the fixture's recovery keypair. A suite that
 * registers through `KEY_BLOBS` opens its own sealed reset challenge with this,
 * which is what proves the account took the real branch: a stored key the
 * server cannot seal to falls back to the enumeration decoy, and
 * `openResetChallenge` throws on a decoy-sealed challenge.
 */
export const RECOVERY_PRIVATE_KEY: Uint8Array = recoveryKeyPair.privateKey;

/**
 * Real key material, not filler: the write paths check blob shape, so a
 * placeholder no longer registers. Each blob is still distinct — register-finish
 * decodes every base64 field by destructuring one positional `Result.combine`
 * array, so blobs sharing bytes would let a field transposition store the wrong
 * value and still satisfy every assertion; the two wraps differ because they are
 * built under different export keys.
 *
 * The wraps are shape-real rather than phrase-derived: the recovery blob is not
 * openable by `RECOVERY_PRIVATE_KEY`, because deriving a wrap from a mnemonic
 * costs a 64 MiB Argon2id per import. Tests that need a real phrase round trip
 * build their own material.
 */
export const KEY_BYTES = {
  accountPublicKey: accountKeyPair.publicKey,
  passwordWrappedPrivateKey: rewrapAccountKeyForPasswordChange(
    accountKeyPair.privateKey,
    new Uint8Array(32).fill(8)
  ),
  recoveryWrappedPrivateKey: rewrapAccountKeyForPasswordChange(
    accountKeyPair.privateKey,
    new Uint8Array(32).fill(9)
  ),
  recoveryPublicKey: recoveryKeyPair.publicKey,
};
export const KEY_BLOBS = {
  accountPublicKey: toBase64(KEY_BYTES.accountPublicKey),
  passwordWrappedPrivateKey: toBase64(KEY_BYTES.passwordWrappedPrivateKey),
  recoveryWrappedPrivateKey: toBase64(KEY_BYTES.recoveryWrappedPrivateKey),
  recoveryPublicKey: toBase64(KEY_BYTES.recoveryPublicKey),
};

interface RegisterInitBody {
  registrationResponse: number[];
  registerSessionId: string;
}

/**
 * What a signup may carry beyond its credentials: the campaign tag the link
 * held, the acquisition stamp the finish round writes, and an address to
 * present, which the growth funnel counts one member per.
 */
export interface RegistrationExtras {
  readonly campaign?: string;
  readonly acquisition?: { readonly campaign?: string; readonly platform: string };
  readonly address?: string;
}

function addressHeaders(extras: RegistrationExtras): Record<string, string> {
  return extras.address === undefined ? {} : { 'x-forwarded-for': extras.address };
}

/**
 * Two documentation-range addresses (RFC 5737) on networks that differ, so a
 * counter keyed in part on the caller's network tells one from the other.
 */
export const ONE_NETWORK = '192.0.2.10';
export const ANOTHER_NETWORK = '198.51.100.10';

export async function registerInit(
  account: { email: string; username: string; password: string },
  client: ReturnType<typeof createOpaqueClient> = createOpaqueClient(),
  extras: RegistrationExtras = {}
): Promise<{ res: Response; body: RegisterInitBody }> {
  const { serialized } = await opaqueClientStartRegistration(client, account.password);
  const res = await post(
    '/auth/register/init',
    {
      email: account.email,
      username: account.username,
      registrationRequest: serialized,
      ...(extras.campaign === undefined ? {} : { c: extras.campaign }),
    },
    undefined,
    { headers: addressHeaders(extras) }
  );
  expect(res.status).toBe(200);
  return { res, body: await res.json() };
}

export async function registerAccount(
  account = uniqueAccount(),
  keyBlobs = KEY_BLOBS,
  extras: RegistrationExtras = {}
): Promise<{ email: string; username: string; password: string; userId: string }> {
  const client = createOpaqueClient();
  const { body } = await registerInit(account, client, extras);
  const { record } = await opaqueClientFinishRegistration(
    client,
    body.registrationResponse,
    OPAQUE_SERVER_IDENTIFIER
  );
  const res = await post(
    '/auth/register/finish',
    {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...keyBlobs,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
      ...(extras.acquisition === undefined ? {} : { acquisition: extras.acquisition }),
    },
    undefined,
    { headers: addressHeaders(extras) }
  );
  expect(res.status).toBe(201);
  const finished = await res.json<{ success: boolean; userId: string }>();
  expect(finished.success).toBe(true);
  return { ...account, userId: finished.userId };
}

interface LoginInitBody {
  ke2: number[];
  loginSessionId: string;
}

export async function loginInit(
  identifier: string,
  password: string,
  client: ReturnType<typeof createOpaqueClient> = createOpaqueClient(),
  address?: string
): Promise<{ res: Response; body: LoginInitBody }> {
  const { ke1 } = await opaqueClientStartLogin(client, password);
  const res = await post('/auth/login/init', { identifier, ke1 }, undefined, {
    headers: addressHeaders({ ...(address === undefined ? {} : { address }) }),
  });
  return { res, body: await res.json() };
}

export interface LoginSuccessBody {
  success: true;
  userId: string;
  email: string;
  passwordWrappedPrivateKey: string;
}

export function sessionCookieOf(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
  const value = header?.split(`${SESSION_COOKIE_NAME}=`)[1]?.split(';')[0];
  return `${SESSION_COOKIE_NAME}=${value ?? ''}`;
}

export function billingPortalCookieOf(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).toContain(`${BILLING_PORTAL_COOKIE_NAME}=`);
  const value = header?.split(`${BILLING_PORTAL_COOKIE_NAME}=`)[1]?.split(';')[0];
  return `${BILLING_PORTAL_COOKIE_NAME}=${value ?? ''}`;
}

/**
 * Marks an account's email verified, modelling the click-through of the
 * verification link. Real accounts must verify before login, so the
 * many login-success paths mark verified via `login`; an unknown identifier
 * matches no row. The gate itself is covered explicitly by its own suite.
 */
export async function markVerified(identifier: string): Promise<void> {
  const column = identifier.includes('@') ? users.email : users.username;
  await db.update(users).set({ emailVerified: true }).where(eq(column, identifier.toLowerCase()));
}

/**
 * The OPAQUE login round-trip WITHOUT verifying — used to exercise the gate.
 * Both rounds present the same address when one is given, which is what a real
 * client does and what the per-network counter's clear is keyed on.
 */
export async function loginRoundTrip(
  identifier: string,
  password: string,
  address?: string
): Promise<Response> {
  const client = createOpaqueClient();
  const { res: initRes, body } = await loginInit(identifier, password, client, address);
  expect(initRes.status).toBe(200);
  const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
  return post(
    '/auth/login/finish',
    { identifier, ke3, loginSessionId: body.loginSessionId },
    undefined,
    { headers: addressHeaders({ ...(address === undefined ? {} : { address }) }) }
  );
}

export async function login(
  identifier: string,
  password: string,
  address?: string
): Promise<Response> {
  await markVerified(identifier);
  return loginRoundTrip(identifier, password, address);
}

export async function fullSessionCookie(): Promise<string> {
  const account = await registerAccount();
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

export async function pendingSessionCookie(): Promise<string> {
  const account = await registerAccount();
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

export async function billingPortalCredentialCookie(): Promise<string> {
  const account = await registerAccount();
  const response = new Response();
  const issued = await issueBillingPortalCredential({
    request: new Request('http://localhost/auth/token-login'),
    response,
    redis,
    secret: SECRET,
    isProduction: false,
    userId: account.userId,
    sessionId: crypto.randomUUID(),
    now: Date.now(),
  });
  issued._unsafeUnwrap();
  return billingPortalCookieOf(response);
}

export async function unsealBillingPortalCredential(cookie: string): Promise<BillingPortalClaims> {
  const sealed = cookie.split(`${BILLING_PORTAL_COOKIE_NAME}=`)[1] ?? '';
  const credential = parseBillingPortalClaims(await unsealData(sealed, { password: SECRET }));
  if (credential === null) throw new Error('test cookie did not unseal to a valid credential');
  return credential;
}

export async function unsealClaims(cookie: string): Promise<SessionClaims> {
  const sealed = cookie.split(`${SESSION_COOKIE_NAME}=`)[1] ?? '';
  const claims = parseSessionClaims(await unsealData(sealed, { password: SECRET }));
  if (claims === null) throw new Error('test cookie did not unseal to valid claims');
  return claims;
}

/** A shape-valid rotation blob: the write paths refuse anything else. */
export const NEW_WRAPPED_KEY = toBase64(
  rewrapAccountKeyForPasswordChange(accountKeyPair.privateKey, new Uint8Array(32).fill(4))
);

export async function registerLoginFull(): Promise<{
  account: { email: string; username: string; password: string; userId: string };
  cookie: string;
}> {
  const account = await registerAccount();
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return { account, cookie: sessionCookieOf(res) };
}

/** A full-session cookie whose account has completed TOTP enrollment. */
export async function enrolledFullCookie(): Promise<string> {
  const { cookie } = await registerLoginFull();
  await enrollTotp(cookie);
  return cookie;
}

export async function enrollTotp(cookie: string): Promise<string> {
  const setup = await post('/auth/2fa/setup', {}, cookie);
  expect(setup.status).toBe(200);
  const { secret } = await setup.json<{ totpUri: string; secret: string }>();
  const verify = await post('/auth/2fa/verify', { code: generateTotpCodeSync(secret) }, cookie);
  expect(verify.status).toBe(200);
  return secret;
}

/** A wrong TOTP code that is guaranteed to differ from the live one. */
export function wrongCode(secret: string): string {
  return generateTotpCodeSync(secret) === '000000' ? '111111' : '000000';
}

/** Finishes the client side of an OPAQUE step-up handshake into a KE3. */
export async function stepUpKe3(
  ke2: number[],
  client: ReturnType<typeof createOpaqueClient>
): Promise<number[]> {
  const { ke3 } = await opaqueClientFinishLogin(client, ke2, OPAQUE_SERVER_IDENTIFIER);
  return ke3;
}

// Shared cleanup runs once per importing test file (each file is its own vitest
// module graph → its own PREFIX, db client, and afterAll). Only identity-owned
// tables are reclaimed here; a file that seeds a cross-slice table (only
// routes-deletion, with `conversations`) reclaims that table in its own
// `afterAll`, which — being registered later — runs BEFORE this one (vitest runs
// afterAll LIFO), clearing the FK dependents before the users delete. Keeping the
// cross-slice write out of this non-`*.test.ts` module also satisfies the
// single-writer-per-table arch rule, which exempts only `*.test.ts`.
afterAll(async () => {
  await db.delete(users).where(like(users.username, `${PREFIX}%`));
  // Deletion events are anonymous; the run-unique userAgent markers are the
  // only handle this suite has on its own rows.
  await db.delete(accountDeletionEvents).where(like(accountDeletionEvents.userAgent, `${PREFIX}%`));
  await db.$client.end();
});
