import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  campaigns,
  ledgerEntries,
  termsAcceptances,
  userAcquisition,
  users,
  wallets,
} from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES, TERMS_OF_SERVICE_REVISION, fromBase64, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { bindRequestValue } from '../../lib/context/index.js';
import { runSettlement } from '../../lib/idempotency/index.js';
import {
  GROWTH_REDIS_KEYS,
  callerIpIdForAddress,
  growthDayBucket,
  growthHourBucket,
} from '../../lib/redis/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { checkSessionRevocation, createIdentityManifest, createIdentityStores } from './index.js';
import { WELCOME_CREDIT_NANO_USD, provisionWalletsWithinTx } from '../billing/index.js';
import { dailyAddressId } from '../growth/domain/visitor-hash.js';
import {
  KEY_BLOBS,
  KEY_BYTES,
  PREFIX,
  billingStores,
  db,
  emailPortFailure,
  expectStatus,
  get,
  login,
  loginInit,
  manifestDeps,
  post,
  redis,
  registerAccount,
  registerInit,
  sentVerifications,
  sentWelcome,
  testEnv,
  uniqueAccount,
} from './routes.integration.setup.js';
import type { Redis } from '@upstash/redis';
import type { AppEnv } from '../../lib/context/index.js';

describe('identity routes: registration', () => {
  it('completes the two-round OPAQUE registration and stores the wrapped keys', async () => {
    const created = await registerAccount();
    const [row] = await db
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
        publicKey: users.publicKey,
        passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
        recoveryPublicKey: users.recoveryPublicKey,
      })
      .from(users)
      .where(eq(users.id, created.userId));
    if (row === undefined) throw new Error('registered user row missing');
    expect(row.email).toBe(created.email);
    expect(row.emailVerified).toBe(false);
    expect([...row.publicKey]).toEqual([...KEY_BYTES.accountPublicKey]);
    expect([...row.passwordWrappedPrivateKey]).toEqual([...KEY_BYTES.passwordWrappedPrivateKey]);
    expect([...row.recoveryWrappedPrivateKey]).toEqual([...KEY_BYTES.recoveryWrappedPrivateKey]);
    expect([...row.recoveryPublicKey]).toEqual([...KEY_BYTES.recoveryPublicKey]);
  });

  it('answers a duplicate email with the same fake-success shape and creates no second row', async () => {
    const existing = await registerAccount();
    const duplicate = { ...uniqueAccount(), email: existing.email };
    const client = createOpaqueClient();
    const { body } = await registerInit(duplicate, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: duplicate.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    });
    expect(res.status).toBe(201);
    const finished = await res.json<{ success: boolean; userId: string }>();
    expect(finished.success).toBe(true);
    expect(finished.userId).not.toBe(existing.userId);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, existing.email));
    expect(rows).toHaveLength(1);
  });

  it('answers a duplicate username with the typed conflict', async () => {
    const existing = await registerAccount();
    const duplicate = { ...uniqueAccount(), username: existing.username };
    const client = createOpaqueClient();
    const { body } = await registerInit(duplicate, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: duplicate.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.USERNAME_TAKEN });
  });

  it('rejects malformed OPAQUE registration-request bytes as validation input', async () => {
    const account = uniqueAccount();
    const res = await post('/auth/register/init', {
      email: account.email,
      username: account.username,
      registrationRequest: [1, 2, 3],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a replayed register handshake (pending state is single-use)', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finishBody = {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    };
    await expectStatus(post('/auth/register/finish', finishBody), 201);
    const replay = await post('/auth/register/finish', finishBody);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
  });

  it('creates exactly one row when two finish deliveries race the same handshake', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finishBody = {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    };
    const [first, second] = await Promise.all([
      post('/auth/register/finish', finishBody),
      post('/auth/register/finish', finishBody),
    ]);
    const statuses = [first.status, second.status].toSorted((a, b) => a - b);
    // The atomic consume gives the handshake to one delivery; the loser sees
    // no pending state — never a second INSERT attempt on the same account.
    expect(statuses).toEqual([201, 400]);
    const loser = first.status === 400 ? first : second;
    expect(await loser.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toHaveLength(1);
  });

  it('rejects a finish whose email does not match the pending handshake', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: `other-${account.email}`,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
  });

  it('refuses a finish under a KEK other than the one its init pinned, inserting nothing', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
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
        ...KEY_BLOBS,
        acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
      },
      undefined,
      { env: { ...testEnv, OPAQUE_KEK: 'rotated-kek-at-least-32-characters-long!!' } } // gitleaks:allow
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.OPAQUE_KEK_ROTATED });
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toHaveLength(0);
  });

  it('bounds the pending registration state with the registry TTL', async () => {
    const account = uniqueAccount();
    const { body } = await registerInit(account);
    const ttl = await redis.ttl(
      IDENTITY_KEYS.opaquePendingRegistration.buildKey(body.registerSessionId)
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDENTITY_KEYS.opaquePendingRegistration.ttlSeconds);
  });

  it('rate-limits registration per email at the registry window', async () => {
    const account = uniqueAccount();
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.registerRateLimit;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await registerInit(account);
    }
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: account.username,
      registrationRequest: serialized,
    });
    expect(res.status).toBe(429);
    const body = await res.json<{ code: string; details: { retryAfterSeconds: number } }>();
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });
});

describe('identity routes: username rule at registration', () => {
  it('rejects a reserved username before any account row exists', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: 'admin',
      registrationRequest: serialized,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, 'admin'));
    expect(rows).toHaveLength(0);
  });

  it('rejects a reserved username submitted in a casing the server would normalize away', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: 'Admin',
      registrationRequest: serialized,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a one-character username', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: 'a',
      registrationRequest: serialized,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a username starting with a digit', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: '1user',
      registrationRequest: serialized,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a username containing punctuation', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: 'john.smith',
      registrationRequest: serialized,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('still accepts a spaced, mixed-case display name and stores its normalized form', async () => {
    const account = uniqueAccount();
    const created = await registerAccount({ ...account, username: `${PREFIX} Spaced Name` });
    const [row] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, created.userId));
    expect(row?.username).toBe(`${PREFIX}_spaced_name`);
  });

  it('leaves an account that already holds a reserved name able to sign in', async () => {
    // Option C grandfathers existing rows: the rule is a registration-time
    // boundary check, never a re-validation of stored usernames.
    const account = await registerAccount();
    try {
      await db.update(users).set({ username: 'admin' }).where(eq(users.id, account.userId));
      const res = await login('admin', account.password);
      expect(res.status).toBe(200);
    } finally {
      await db.delete(users).where(eq(users.id, account.userId));
    }
  });
});

describe('identity routes: input hardening', () => {
  it('rejects a schema-invalid body with the uniform validation shape', async () => {
    const res = await post('/auth/login/init', { identifier: 'x@identity-routes.test', ke1: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a malformed base64 key blob with the uniform validation shape', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
      accountPublicKey: '!!!!!',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  /**
   * The stored key material is the account's only copy, and the recovery public
   * key is sealed to on a public route, so shape is checked before the write:
   * wrong bytes would either lose the account's data or plant a permanent
   * failure on its own reset path.
   */
  describe('key-material shape', () => {
    async function registerFinishWith(override: Record<string, string>): Promise<Response> {
      const account = uniqueAccount();
      const client = createOpaqueClient();
      const { body } = await registerInit(account, client);
      const { record } = await opaqueClientFinishRegistration(
        client,
        body.registrationResponse,
        OPAQUE_SERVER_IDENTIFIER
      );
      return post('/auth/register/finish', {
        email: account.email,
        registrationRecord: record,
        registerSessionId: body.registerSessionId,
        ...KEY_BLOBS,
        acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
        ...override,
      });
    }

    it('rejects a recovery public key of the wrong length', async () => {
      const res = await registerFinishWith({
        recoveryPublicKey: toBase64(new Uint8Array(31).fill(3)),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    });

    it('rejects a low-order recovery public key', async () => {
      // 32 zero bytes are a valid-length encoding of a small-order point: the
      // X25519 shared secret is zero, so sealing a challenge to it throws and
      // the reset route would 500 for anyone who asked after it.
      const res = await registerFinishWith({ recoveryPublicKey: toBase64(new Uint8Array(32)) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    });

    it('rejects an account public key of the wrong length', async () => {
      const res = await registerFinishWith({
        accountPublicKey: toBase64(new Uint8Array(33).fill(7)),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    });

    it('rejects a password-wrapped key of the wrong length', async () => {
      const res = await registerFinishWith({
        passwordWrappedPrivateKey: toBase64(new Uint8Array([8, 8, 8])),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    });

    it('rejects a recovery-wrapped key carrying an unknown version byte', async () => {
      const wrongVersion = Uint8Array.from(fromBase64(KEY_BLOBS.recoveryWrappedPrivateKey));
      wrongVersion[0] = 0x01;
      const res = await registerFinishWith({
        recoveryWrappedPrivateKey: toBase64(wrongVersion),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    });

    it('stores nothing for a rejected registration', async () => {
      const account = uniqueAccount();
      const client = createOpaqueClient();
      const { body } = await registerInit(account, client);
      const { record } = await opaqueClientFinishRegistration(
        client,
        body.registrationResponse,
        OPAQUE_SERVER_IDENTIFIER
      );
      const res = await post('/auth/register/finish', {
        email: account.email,
        registrationRecord: record,
        registerSessionId: body.registerSessionId,
        ...KEY_BLOBS,
        acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
        recoveryPublicKey: toBase64(new Uint8Array(32)),
      });
      expect(res.status).toBe(400);
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, account.email));
      expect(rows).toEqual([]);
    });
  });

  it('answers a typed conflict when the email is claimed between init and finish', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    // The same email completes a full registration through a second
    // handshake while the first is still pending.
    await registerAccount({ ...uniqueAccount(), email: account.email });
    const res = await post('/auth/register/finish', {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.EMAIL_TAKEN });
  });

  it('treats an account whose stored OPAQUE record is corrupt as a defect, not a 400', async () => {
    const account = uniqueAccount();
    const inserted = await runSettlement(db, (tx) =>
      createIdentityStores(db).users.insertRegisteredWithinTx(tx, {
        id: crypto.randomUUID(),
        email: account.email,
        username: account.username,
        opaqueRegistration: new Uint8Array([9, 9, 9]),
        opaqueServerMaterial: new Uint8Array([9, 9, 9]),
        opaqueKekFingerprint: new Uint8Array(8),
        publicKey: KEY_BYTES.accountPublicKey,
        passwordWrappedPrivateKey: KEY_BYTES.passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey: KEY_BYTES.recoveryWrappedPrivateKey,
        recoveryPublicKey: KEY_BYTES.recoveryPublicKey,
      })
    );
    if (inserted.kind !== 'created') throw new Error('corrupt-record seed failed');
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/login/init', { identifier: account.email, ke1 });
    // Server-side data corruption is a DEFECT: it surfaces as a 500 (the
    // assembly's onError maps that to {code: INTERNAL} for telemetry as an
    // invariant break) and must NOT be the distinguishable 400 VALIDATION a
    // healthy account never returns. A malformed CLIENT record stays 400.
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(ERROR_CODES.VALIDATION);
  });

  it('collapses a user deleted mid-handshake onto auth-failed', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await post('/auth/login/finish', {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });
});

describe('identity routes: registration provisioning (wallets + welcome credit)', () => {
  it('provisions a purchased and a free wallet, the welcome credit landing as one promo leg on the purchased one', async () => {
    const account = await registerAccount();
    const rows = await db
      .select({ id: wallets.id, type: wallets.type, balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, account.userId));
    const byType = new Map(rows.map((row) => [row.type, row]));
    const purchased = byType.get('purchased');
    expect(purchased).toBeDefined();
    expect(byType.get('free')).toBeDefined();
    // The welcome credit landed on the purchased wallet as a promo grant.
    expect(purchased?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd, kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, purchased?.id ?? ''));
    expect(legs).toEqual([{ amountNanoUsd: WELCOME_CREDIT_NANO_USD, kind: 'promo' }]);
  });

  it('sends the welcome email when the credit is granted', async () => {
    const account = await registerAccount();
    expect(sentWelcome.some((message) => message.to === account.email.toLowerCase())).toBe(true);
  });

  it('grants the welcome credit at most once per user (idempotent re-provision)', async () => {
    const account = await registerAccount();
    // A second provisioning pass (a retry) must not double-grant — the
    // welcome:<userId> ledger idempotency keys are the guard.
    await runSettlement(db, (tx) => provisionWalletsWithinTx(billingStores, tx, account.userId));
    const [purchased] = await db
      .select({ id: wallets.id, balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(and(eq(wallets.userId, account.userId), eq(wallets.type, 'purchased')));
    expect(purchased?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, purchased?.id ?? ''));
    expect(legs).toHaveLength(1);
  });

  it('rolls back the account when provisioning fails — no walletless user', async () => {
    const brokenBilling = {
      ...billingStores,
      insertWalletIfAbsentWithinTx: () => {
        throw new Error('provision boom');
      },
    };
    const brokenManifest = createIdentityManifest({
      ...manifestDeps,
      billingStores: brokenBilling,
    });
    const brokenApp = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    brokenApp.route(brokenManifest.basePath, brokenManifest.routes);

    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await brokenApp.request(
      '/auth/register/finish',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: account.email,
          registrationRecord: record,
          registerSessionId: body.registerSessionId,
          ...KEY_BLOBS,
          acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
        }),
      },
      testEnv
    );
    // The settlement threw during provisioning, rolling back the account INSERT
    // (single-settlement): the user must not exist, so there is no walletless
    // account that would 403 on its first turn.
    expect(finish.status).toBe(503);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toHaveLength(0);
  });
});

describe('identity routes: registration verification email', () => {
  it('issues a verification token and sends the link on registration', async () => {
    sentVerifications.length = 0;
    const account = await registerAccount();
    expect(sentVerifications.some((message) => message.to === account.email.toLowerCase())).toBe(
      true
    );
    // A live token exists (the dev-link reads the newest unexpired one).
    const devLink = await get(
      `/auth/verify-email/dev-link?email=${encodeURIComponent(account.email)}`
    );
    expect(devLink.status).toBe(200);
    const { token } = await devLink.json<{ token: string }>();
    expect(token).toBeTruthy();
  });

  it('still returns 201 when the verification email send fails', async () => {
    emailPortFailure.shouldFail = true;
    try {
      // registerAccount asserts a 201 internally — the best-effort send failure
      // must not fail registration.
      const account = await registerAccount();
      expect(account.userId).toBeTruthy();
    } finally {
      emailPortFailure.shouldFail = false;
    }
  });
});

/**
 * The hour buckets a request sent now could have landed in. Two only when the
 * call straddles the boundary, which the server-derived bucket makes possible
 * and nothing about the assertion should depend on.
 */
function bucketsAround(before: Date, after: Date): readonly string[] {
  const first = growthHourBucket(before);
  const second = growthHourBucket(after);
  return first === second ? [first] : [first, second];
}

/** How many addresses one campaign's set holds, across the buckets in play. */
async function startedMembers(
  buckets: readonly string[],
  campaign: string,
  key: 'started' | 'startedDecoy'
): Promise<number> {
  const counts = await Promise.all(
    buckets.map(async (bucket) => redis.scard(GROWTH_REDIS_KEYS[key].buildKey(bucket, campaign)))
  );
  return counts.reduce((total, count) => total + count, 0);
}

/** Every member one campaign's started set holds, across the buckets in play. */
async function startedMemberIds(
  buckets: readonly string[],
  campaign: string
): Promise<readonly string[]> {
  const members = await Promise.all(
    buckets.map(async (bucket) =>
      redis.smembers(GROWTH_REDIS_KEYS.started.buildKey(bucket, campaign))
    )
  );
  return members.flat();
}

/** The secret the suite's bindings derive growth identities under. */
function growthSecret(): string {
  const secret = testEnv.GROWTH_HASH_SECRET;
  if (secret === undefined) throw new Error('the suite bindings carry no growth secret');
  return secret;
}

/**
 * Puts one tag in the active-campaign registry the tag resolver reads, so a
 * test counts under a key of its own rather than sharing `direct` with every
 * other registration this suite runs.
 */
async function activeCampaign(): Promise<string> {
  const tag = `c-${crypto.randomUUID().slice(0, 8)}`;
  await redis.set(GROWTH_REDIS_KEYS.activeCampaigns.buildKey(), [tag], { ex: 300 });
  return tag;
}

/**
 * An active campaign that also exists as a row, for the stamp — the account's
 * campaign column is a foreign key, so a tag the registry names must be one a
 * campaign row carries, which is true of every real tag because campaigns are
 * archived and never deleted.
 */
async function activeCampaignRow(): Promise<string> {
  const tag = await activeCampaign();
  await db
    .insert(campaigns)
    .values({ tag, label: 'registration stamp fixture', status: 'active' })
    .onConflictDoNothing();
  return tag;
}

/** An address no other test in this run presents. */
function uniqueAddress(): string {
  const octet = (): number => 1 + Math.floor(Math.random() * 254);
  return `203.0.113.${String(octet())}`;
}

describe('identity routes: the registration funnel count', () => {
  it('counts one member for a handshake replayed from one address', async () => {
    const campaign = await activeCampaign();
    const address = uniqueAddress();
    const account = uniqueAccount();

    const before = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await registerInit(account, createOpaqueClient(), { campaign, address });
    }
    const after = new Date();

    const buckets = bucketsAround(before, after);
    expect(await startedMembers(buckets, campaign, 'started')).toBe(1);
  });

  it('counts a second address under the same campaign as a second member', async () => {
    const campaign = await activeCampaign();

    const before = new Date();
    await registerInit(uniqueAccount(), createOpaqueClient(), {
      campaign,
      address: uniqueAddress(),
    });
    await registerInit(uniqueAccount(), createOpaqueClient(), {
      campaign,
      address: uniqueAddress(),
    });
    const after = new Date();

    expect(await startedMembers(bucketsAround(before, after), campaign, 'started')).toBe(2);
  });

  it('sends the existing-email decoy to its own set and leaves the counted one empty', async () => {
    const existing = await registerAccount();
    const campaign = await activeCampaign();
    const address = uniqueAddress();

    const before = new Date();
    await registerInit({ ...uniqueAccount(), email: existing.email }, createOpaqueClient(), {
      campaign,
      address,
    });
    const after = new Date();

    const buckets = bucketsAround(before, after);
    expect(await startedMembers(buckets, campaign, 'startedDecoy')).toBe(1);
    expect(await startedMembers(buckets, campaign, 'started')).toBe(0);
  });

  // Keyed under the day and a label of its own: a reader without the secret
  // can neither reverse the member to an address nor join it to a mint key.
  it('files the start under the address’s day-keyed started identity', async () => {
    const campaign = await activeCampaign();
    const address = uniqueAddress();

    const before = new Date();
    await registerInit(uniqueAccount(), createOpaqueClient(), { campaign, address });
    const after = new Date();

    const days = [...new Set([before, after].map((at) => growthDayBucket(at)))];
    const keyed = await Promise.all(
      days.map(async (day) =>
        dailyAddressId({ secret: growthSecret(), address, day, set: 'started' })
      )
    );
    const members = await startedMemberIds(bucketsAround(before, after), campaign);
    expect(members).toHaveLength(1);
    expect(keyed).toContain(members[0]);
  });

  it('never files the unkeyed address digest as a start', async () => {
    const campaign = await activeCampaign();
    const address = uniqueAddress();

    const before = new Date();
    await registerInit(uniqueAccount(), createOpaqueClient(), { campaign, address });
    const after = new Date();

    const members = await startedMemberIds(bucketsAround(before, after), campaign);
    expect(members).toHaveLength(1);
    expect(members).not.toContain(await callerIpIdForAddress(address));
  });

  // Growth counting is best-effort and never fails a signup, so a deployment
  // missing the growth secret answers the handshake and says so once.
  it('still registers when the growth secret is absent', async () => {
    const captureError = vi.fn();

    const res = await initThrough(appWith(redis, captureError), {
      ...testEnv,
      GROWTH_HASH_SECRET: undefined,
    });

    expect(res.status).toBe(200);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'growth_registration_start_unavailable'
    );
  });

  it('still registers when the growth count cannot be written', async () => {
    // The tag resolver reads the campaign registry on a cache miss, so a store
    // that refuses is a growth failure inside the init flow. The count is
    // best-effort and authentication never degrades: the handshake answers 200
    // exactly as it does with a healthy counter.
    await redis.del(GROWTH_REDIS_KEYS.activeCampaigns.buildKey());
    const brokenManifest = createIdentityManifest({
      ...manifestDeps,
      growthStores: {
        listActiveCampaignTags: () => errAsync(unavailableError('growth campaign read failed')),
      },
    });
    const brokenApp = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    brokenApp.route(brokenManifest.basePath, brokenManifest.routes);

    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await brokenApp.request(
      '/auth/register/init',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: account.email,
          username: account.username,
          registrationRequest: serialized,
          c: 'a-live-link',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(200);
  });

  it('reports the first address the start ceiling turns away', async () => {
    const { captureError } = await initAtTheCeiling();

    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), 'growth_set_overflowed');
  });

  it('still answers the handshake when the ceiling turned the address away', async () => {
    const { status } = await initAtTheCeiling();

    expect(status).toBe(200);
  });

  it('reports nothing for a start the ceiling admits', async () => {
    const captureError = vi.fn();
    const app = appWith(redis, captureError);

    const res = await initThrough(app);

    expect(res.status).toBe(200);
    expect(captureError).not.toHaveBeenCalledWith(expect.any(Error), 'growth_set_overflowed');
  });
});

/**
 * The real client, with the registration-start count alone answering that this
 * call was the one that latched its bucket's overflow flag. Every other command
 * — the throttle, the campaign registry, the pending handshake — reaches the
 * real store, so what a case built on this exercises is the init flow's reading
 * of that one reply.
 *
 * The gate function's name is what picks the script out. A rename there stops
 * the interception, and a case that depends on a latch goes red rather than
 * quiet.
 */
function latchingRedis(): Redis {
  return new Proxy(redis, {
    get: (target, property, receiver) => {
      if (property !== 'createScript') {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (script: string) =>
        script.includes('addUnderCeiling')
          ? { exec: () => Promise.resolve(1) }
          : target.createScript(script);
    },
  });
}

/** The identity routes over a chosen store and a recording capture channel. */
function appWith(store: Redis, captureError: (error: Error, code: string) => void): Hono<AppEnv> {
  const manifest = createIdentityManifest(manifestDeps);
  const app = applyPipeline(new Hono<AppEnv>(), {
    session: { revocation: checkSessionRevocation },
  });
  app.use('*', async (c, next) => {
    bindRequestValue(c, 'redis', store);
    bindRequestValue(c, 'logger', { ...c.var.logger, captureError });
    await next();
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/** One register-init handshake through a chosen app, under the suite's bindings unless named. */
async function initThrough(
  app: Hono<AppEnv>,
  env: Parameters<Hono<AppEnv>['request']>[2] = testEnv
): Promise<Response> {
  const account = uniqueAccount();
  const { serialized } = await opaqueClientStartRegistration(
    createOpaqueClient(),
    account.password
  );
  return app.request(
    '/auth/register/init',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: account.email,
        username: account.username,
        registrationRequest: serialized,
      }),
    },
    env
  );
}

/** One register-init handshake whose funnel count is refused at the ceiling. */
async function initAtTheCeiling(): Promise<{
  readonly status: number;
  readonly captureError: ReturnType<typeof vi.fn>;
}> {
  const captureError = vi.fn();
  const res = await initThrough(appWith(latchingRedis(), captureError));
  return { status: res.status, captureError };
}

describe('identity routes: the acquisition stamp', () => {
  it('stamps the account with the campaign and platform the signup carried', async () => {
    const campaign = await activeCampaignRow();
    const created = await registerAccount(uniqueAccount(), KEY_BLOBS, {
      campaign,
      acquisition: { campaign, platform: 'ios' },
    });

    const [row] = await db
      .select({ campaign: userAcquisition.campaign, platform: userAcquisition.platform })
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, created.userId));
    expect(row).toEqual({ campaign, platform: 'ios' });
  });

  it('records a signup that named no campaign as direct', async () => {
    const created = await registerAccount(uniqueAccount(), KEY_BLOBS, {
      acquisition: { platform: 'web' },
    });

    const [row] = await db
      .select({ campaign: userAcquisition.campaign })
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, created.userId));
    expect(row?.campaign).toBe('direct');
  });

  it('records a tag no campaign carries as unknown rather than refusing the signup', async () => {
    await redis.set(GROWTH_REDIS_KEYS.activeCampaigns.buildKey(), [], { ex: 300 });
    const created = await registerAccount(uniqueAccount(), KEY_BLOBS, {
      acquisition: { campaign: 'a-retired-link', platform: 'web' },
    });

    const [row] = await db
      .select({ campaign: userAcquisition.campaign })
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, created.userId));
    expect(row?.campaign).toBe('unknown');
  });

  it('leaves no acquisition row behind when the registration rolls back', async () => {
    const brokenBilling = {
      ...billingStores,
      insertWalletIfAbsentWithinTx: () => {
        throw new Error('provision boom');
      },
    };
    const brokenManifest = createIdentityManifest({
      ...manifestDeps,
      billingStores: brokenBilling,
    });
    const brokenApp = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    brokenApp.route(brokenManifest.basePath, brokenManifest.routes);

    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await brokenApp.request(
      '/auth/register/finish',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: account.email,
          registrationRecord: record,
          registerSessionId: body.registerSessionId,
          ...KEY_BLOBS,
          acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
          acquisition: { platform: 'web' },
        }),
      },
      testEnv
    );

    expect(finish.status).toBe(503);
    const rows = await db
      .select({ id: userAcquisition.id })
      .from(userAcquisition)
      .innerJoin(users, eq(users.id, userAcquisition.userId))
      .where(eq(users.email, account.email));
    expect(rows).toHaveLength(0);
  });
});

describe('identity routes: the Terms acceptance', () => {
  async function acceptedRevisionsOf(
    email: string
  ): Promise<{ userId: string; revision: number }[]> {
    return db
      .select({ userId: termsAcceptances.userId, revision: termsAcceptances.revision })
      .from(termsAcceptances)
      .innerJoin(users, eq(users.id, termsAcceptances.userId))
      .where(eq(users.email, email));
  }

  async function pendingFinish(): Promise<{
    account: ReturnType<typeof uniqueAccount>;
    body: Record<string, unknown>;
  }> {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    return {
      account,
      body: {
        email: account.email,
        registrationRecord: record,
        registerSessionId: body.registerSessionId,
        ...KEY_BLOBS,
      },
    };
  }

  it('records the current Terms revision against a new account', async () => {
    const created = await registerAccount();

    expect(await acceptedRevisionsOf(created.email)).toEqual([
      { userId: created.userId, revision: TERMS_OF_SERVICE_REVISION },
    ]);
  });

  it('rejects a stale Terms revision before the handshake is consumed', async () => {
    const { account, body } = await pendingFinish();

    const stale = await post('/auth/register/finish', {
      ...body,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION - 1,
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toEqual([]);

    await expectStatus(
      post('/auth/register/finish', { ...body, acceptedTermsRevision: TERMS_OF_SERVICE_REVISION }),
      201
    );
  });

  it('rejects a finish that names no Terms revision before the handshake is consumed', async () => {
    const { account, body } = await pendingFinish();

    const missing = await post('/auth/register/finish', body);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toEqual([]);

    await expectStatus(
      post('/auth/register/finish', { ...body, acceptedTermsRevision: TERMS_OF_SERVICE_REVISION }),
      201
    );
  });

  it('writes no acceptance when the email is claimed between init and finish', async () => {
    const { account, body } = await pendingFinish();
    const existing = await registerAccount({ ...uniqueAccount(), email: account.email });

    const res = await post('/auth/register/finish', {
      ...body,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.EMAIL_TAKEN });
    expect(await acceptedRevisionsOf(account.email)).toEqual([
      { userId: existing.userId, revision: TERMS_OF_SERVICE_REVISION },
    ]);
  });
});
