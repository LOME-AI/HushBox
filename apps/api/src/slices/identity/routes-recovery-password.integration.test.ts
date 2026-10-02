import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  RESET_CHALLENGE_NONCE_BYTES,
  asWrappingPrivateKey,
  createOpaqueClient,
  deriveResetProof,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateAccountKeyPair,
  generateTotpCodeSync,
  openResetChallenge,
  recoverAccountFromMnemonic,
  regenerateRecoveryPhrase,
  rewrapAccountKeyForPasswordChange,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES, fromBase64, toBase64 } from '@hushbox/shared';
import { ResultAsync } from '../../lib/result/index.js';
import { rateLimitKey } from '../../lib/rate-limit/index.js';
import { createIdentityStores } from './index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import {
  KEY_BLOBS,
  NEW_WRAPPED_KEY,
  PREFIX,
  RECOVERY_PRIVATE_KEY,
  createApp,
  db,
  enrollTotp,
  evictedUserIds,
  expectStatus,
  get,
  login,
  manifestDeps,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sentPasswordChanged,
  sentPasswordReset,
  sessionCookieOf,
  testEnv,
  uniqueAccount,
} from './routes.integration.setup.js';
import type { IdentityRouteDeps } from './index.js';

/** A deployment holding a KEK other than the one the fixture rows are sealed under. */
const ROTATED_KEK_ENV = { ...testEnv, OPAQUE_KEK: 'rotated-kek-at-least-32-characters-long!!' }; // gitleaks:allow

/** A registration record no flow observed: what a racing rotation leaves behind. */
const FOREIGN_RECORD = new Uint8Array([9, 9, 9]);

describe('identity routes: password change', () => {
  interface ChangePasswordStarted {
    readonly ke3: number[];
    readonly record: number[];
    readonly changePasswordSessionId: string;
  }

  async function changePasswordInit(
    cookie: string,
    oldPassword: string,
    newPassword: string
  ): Promise<ChangePasswordStarted> {
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, oldPassword);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(init.status).toBe(200);
    const initBody = await init.json<{
      ke2: number[];
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
    const { ke3 } = await opaqueClientFinishLogin(
      stepClient,
      initBody.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    return { ke3, record, changePasswordSessionId: initBody.changePasswordSessionId };
  }

  async function changePasswordFinish(
    cookie: string,
    started: ChangePasswordStarted,
    env = testEnv
  ): Promise<Response> {
    return post(
      '/auth/change-password/finish',
      {
        ke3: started.ke3,
        newRegistrationRecord: started.record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: started.changePasswordSessionId,
      },
      cookie,
      { env }
    );
  }

  async function changePassword(
    cookie: string,
    oldPassword: string,
    newPassword: string
  ): Promise<Response> {
    return changePasswordFinish(cookie, await changePasswordInit(cookie, oldPassword, newPassword));
  }

  it('answers the internal error at init when the row material is sealed under another KEK', async () => {
    const { account, cookie } = await registerLoginFull();
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), account.password);
    const { serialized } = await opaqueClientStartRegistration(createOpaqueClient(), 'next pw');
    const res = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie,
      { env: ROTATED_KEK_ENV }
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: ERROR_CODES.INTERNAL });
  });

  it('refuses a finish under a KEK other than the one its init pinned, leaving the old password live', async () => {
    const { account, cookie } = await registerLoginFull();
    const started = await changePasswordInit(cookie, account.password, 'rotated kek password');
    const res = await changePasswordFinish(cookie, started, ROTATED_KEK_ENV);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.OPAQUE_KEK_ROTATED });
    await expectStatus(login(account.email, account.password), 200);
  });

  it('refuses a finish whose observed record another rotation replaced, writing nothing', async () => {
    const { account, cookie } = await registerLoginFull();
    const started = await changePasswordInit(cookie, account.password, 'conflicting password');
    await db
      .update(users)
      .set({ opaqueRegistration: FOREIGN_RECORD })
      .where(eq(users.id, account.userId));
    const res = await changePasswordFinish(cookie, started);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CREDENTIAL_CONFLICT });
    const [row] = await db
      .select({ opaqueRegistration: users.opaqueRegistration })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.opaqueRegistration).toEqual(FOREIGN_RECORD);
  });

  it('rotates the password, stales prior sessions, and logs in with the new password', async () => {
    const { account, cookie } = await registerLoginFull();
    await expectStatus(get('/t/session', cookie), 200);
    const newPassword = `${account.password} rotated`;
    const finish = await changePassword(cookie, account.password, newPassword);
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The rotation forwards the eviction port through to close staled sockets.
    expect(evictedUserIds).toContain(account.userId);

    // The security notification reaches the account's address.
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(1);

    // The cookie issued before the watermark is now rejected.
    const stale = await get('/t/session', cookie);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });

    // The new password authenticates (the old one can no longer recover its
    // OPAQUE envelope client-side, so it cannot even produce a finish request).
    const relogin = await login(account.email, newPassword);
    expect(relogin.status).toBe(200);
  });

  it('rejects a wrong old password with the typed auth failure', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'new password here');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post(
      '/auth/change-password/finish',
      {
        ke3: [0, 1, 2],
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
    expect(finish.status).toBe(401);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    // A refused change never notifies.
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(0);
  });

  /**
   * The rotation write replaces the account's only password-wrapped copy of the
   * account key, so a wrong-shaped blob is silent data loss rather than a bad
   * request the user can retry.
   */
  async function changePasswordWith(wrappedKey: string): Promise<Response> {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'shape-checked pw');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{
      ke2: number[];
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
    const { ke3 } = await opaqueClientFinishLogin(
      stepClient,
      initBody.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    return post(
      '/auth/change-password/finish',
      {
        ke3,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: wrappedKey,
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
  }

  it('rejects a rotation whose wrapped key is the wrong length', async () => {
    const res = await changePasswordWith(toBase64(new Uint8Array(32)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a rotation whose wrapped key carries an unknown version byte', async () => {
    const wrongVersion = Uint8Array.from(fromBase64(NEW_WRAPPED_KEY));
    wrongVersion[0] = 0x07;
    const res = await changePasswordWith(toBase64(wrongVersion));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('a revoked session cannot start a step-up op', async () => {
    const { cookie } = await registerLoginFull();
    await expectStatus(post('/auth/logout', {}, cookie), 200);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, 'whatever');
    const { serialized } = await opaqueClientStartRegistration(createOpaqueClient(), 'whatever');
    const res = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('identity routes: recovery', () => {
  it('returns the stored wrapped key for a known account', async () => {
    const account = await registerAccount();
    const res = await post('/auth/recovery/get-wrapped-key', { identifier: account.email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
    });
  });

  it('returns a same-shape dummy for an unknown account (enumeration safety)', async () => {
    const known = await registerAccount();
    const knownRes = await post('/auth/recovery/get-wrapped-key', { identifier: known.email });
    const unknownRes = await post('/auth/recovery/get-wrapped-key', {
      identifier: `${PREFIX}nobody@identity-routes.test`,
    });
    expect(unknownRes.status).toBe(knownRes.status);
    const unknownBody = await unknownRes.json<{ recoveryWrappedPrivateKey: string }>();
    const knownBody = await knownRes.json<{ recoveryWrappedPrivateKey: string }>();
    // Same JSON shape: exactly the one key, a base64 string, on both.
    expect(Object.keys(unknownBody)).toEqual(Object.keys(knownBody));
    expect(typeof unknownBody.recoveryWrappedPrivateKey).toBe('string');
  });

  it('answers a known and an unknown account with byte-identical response length', async () => {
    // A canonical client stores an ECIES wrap of the 32-byte account private
    // key; the dummy must be the same length or the body is an existence oracle.
    const realBlob = rewrapAccountKeyForPasswordChange(
      generateAccountKeyPair().privateKey,
      new Uint8Array(32)
    );
    const known = await registerAccount(uniqueAccount(), {
      ...KEY_BLOBS,
      recoveryWrappedPrivateKey: toBase64(realBlob),
    });
    const knownRes = await post('/auth/recovery/get-wrapped-key', { identifier: known.email });
    const unknownRes = await post('/auth/recovery/get-wrapped-key', {
      identifier: `${PREFIX}void@identity-routes.test`,
    });
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    const knownBody = await knownRes.text();
    const unknownBody = await unknownRes.text();
    expect(unknownBody.length).toBe(knownBody.length);
  });

  async function unknownDummyBytes(identifier: string): Promise<Uint8Array> {
    const res = await post('/auth/recovery/get-wrapped-key', { identifier });
    expect(res.status).toBe(200);
    const body = await res.json<{ recoveryWrappedPrivateKey: string }>();
    return fromBase64(body.recoveryWrappedPrivateKey);
  }

  it('answers repeated queries for the same unknown identifier with the identical dummy', async () => {
    const ghost = `${PREFIX}stable-dummy@identity-routes.test`;
    const first = await unknownDummyBytes(ghost);
    const second = await unknownDummyBytes(ghost);
    expect([...second]).toEqual([...first]);
  });

  it('answers different unknown identifiers with different dummies', async () => {
    const first = await unknownDummyBytes(`${PREFIX}dummy-a@identity-routes.test`);
    const second = await unknownDummyBytes(`${PREFIX}dummy-b@identity-routes.test`);
    expect([...second]).not.toEqual([...first]);
  });

  it('never answers an unknown identifier with an all-zero dummy body', async () => {
    const bytes = await unknownDummyBytes(`${PREFIX}nonzero@identity-routes.test`);
    expect(bytes.slice(1).some((byte) => byte !== 0)).toBe(true);
  });

  it('stamps the real ECIES version byte on the dummy', async () => {
    const realBlob = rewrapAccountKeyForPasswordChange(
      generateAccountKeyPair().privateKey,
      new Uint8Array(32)
    );
    const bytes = await unknownDummyBytes(`${PREFIX}versioned@identity-routes.test`);
    expect(bytes[0]).toBe(realBlob[0]);
  });

  /**
   * The phrase-holder's half of the recovery keypair, held directly by the
   * test. The gate asks exactly one question — can the caller open a challenge
   * sealed to the stored `recovery_public_key`? — so an X25519 keypair whose
   * public half is registered answers it without spending a 64 MiB argon2 per
   * test. That the phrase really derives that keypair is a separate link,
   * pinned where the derivation lives (`packages/crypto`) and end-to-end by the
   * recovery E2E.
   */
  async function registerWithRecoveryKeypair(): Promise<{
    account: Awaited<ReturnType<typeof registerAccount>>;
    recoveryPrivateKey: Uint8Array;
  }> {
    const pair = generateAccountKeyPair();
    const account = await registerAccount(uniqueAccount(), {
      ...KEY_BLOBS,
      recoveryPublicKey: toBase64(pair.publicKey),
    });
    return { account, recoveryPrivateKey: pair.privateKey };
  }

  // The shared fixture registers a real recovery public key, so an account
  // created through it takes the stored-key branch of `challengeRecipient`
  // rather than the unknown-identifier decoy. Opening the challenge is the
  // discriminator: a decoy-sealed challenge is openable by nobody, so this
  // throws `DecryptionFailedError` the moment the fixture stops being a key the
  // server can seal to.
  it('seals the reset challenge to the fixture account own stored recovery key', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, 'fixture branch password');
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    expect(init.status).toBe(200);
    const body = await init.json<{ sealedChallenge: string }>();

    const nonce = openResetChallenge(
      asWrappingPrivateKey(RECOVERY_PRIVATE_KEY),
      fromBase64(body.sealedChallenge)
    );

    expect(nonce).toHaveLength(RESET_CHALLENGE_NONCE_BYTES);
  });

  interface ResetHandshake {
    readonly recoverySessionId: string;
    readonly sealedChallenge: string;
    readonly newRegistrationRecord: number[];
  }

  async function resetInit(identifier: string, newPassword: string): Promise<ResetHandshake> {
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, newPassword);
    const res = await post('/auth/recovery/reset/init', {
      identifier,
      newRegistrationRequest: serialized,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      newRegistrationResponse: number[];
      recoverySessionId: string;
      sealedChallenge: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    return {
      recoverySessionId: body.recoverySessionId,
      sealedChallenge: body.sealedChallenge,
      newRegistrationRecord: record,
    };
  }

  /** The client half of the gate: open the sealed nonce, bind it to this request. */
  function proofFor(
    handshake: ResetHandshake,
    identifier: string,
    recoveryPrivateKey: Uint8Array,
    newPasswordWrappedPrivateKey = NEW_WRAPPED_KEY
  ): string {
    const nonce = openResetChallenge(
      asWrappingPrivateKey(recoveryPrivateKey),
      fromBase64(handshake.sealedChallenge)
    );
    return toBase64(
      deriveResetProof(nonce, {
        recoverySessionId: handshake.recoverySessionId,
        canonicalIdentifier: identifier.toLowerCase(),
        newRegistrationRecord: Uint8Array.from(handshake.newRegistrationRecord),
        newPasswordWrappedPrivateKey,
      })
    );
  }

  async function resetFinish(
    identifier: string,
    handshake: ResetHandshake,
    resetProof: string,
    newPasswordWrappedPrivateKey = NEW_WRAPPED_KEY
  ): Promise<Response> {
    return post('/auth/recovery/reset/finish', {
      identifier,
      newRegistrationRecord: handshake.newRegistrationRecord,
      newPasswordWrappedPrivateKey,
      recoverySessionId: handshake.recoverySessionId,
      resetProof,
    });
  }

  const FORGED_PROOF = toBase64(new Uint8Array(32).fill(7));

  async function credentialColumns(
    userId: string
  ): Promise<{ opaqueRegistration: number[]; passwordWrappedPrivateKey: number[] }> {
    const [row] = await db
      .select({
        opaqueRegistration: users.opaqueRegistration,
        passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
      })
      .from(users)
      .where(eq(users.id, userId));
    return {
      opaqueRegistration: [...(row?.opaqueRegistration ?? [])],
      passwordWrappedPrivateKey: [...(row?.passwordWrappedPrivateKey ?? [])],
    };
  }

  it('refuses a reset finish under a KEK other than the one its init pinned', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const before = await credentialColumns(account.userId);
    const handshake = await resetInit(account.email, 'rotated kek reset password');
    const res = await post(
      '/auth/recovery/reset/finish',
      {
        identifier: account.email,
        newRegistrationRecord: handshake.newRegistrationRecord,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        recoverySessionId: handshake.recoverySessionId,
        resetProof: proofFor(handshake, account.email, recoveryPrivateKey),
      },
      undefined,
      { env: ROTATED_KEK_ENV }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.OPAQUE_KEK_ROTATED });
    expect(await credentialColumns(account.userId)).toEqual(before);
  });

  /**
   * The real stores, except that a rotation loses the race it was about to
   * win: a competing rotation lands between the finish round's lookup and its
   * compare-and-swap, which is the only window the reset's finish-time
   * observation leaves for a conflict.
   */
  const racedStores: IdentityRouteDeps['stores'] = (database) => {
    const real = createIdentityStores(database);
    return {
      ...real,
      users: {
        ...real.users,
        rotatePassword: (args) =>
          ResultAsync.fromSafePromise(
            db
              .update(users)
              .set({ opaqueRegistration: FOREIGN_RECORD })
              .where(eq(users.id, args.userId))
          ).andThen(() => real.users.rotatePassword(args)),
      },
    };
  };

  it('refuses a reset finish whose record a racing rotation replaced, writing nothing', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const handshake = await resetInit(account.email, 'raced reset password');
    const res = await post(
      '/auth/recovery/reset/finish',
      {
        identifier: account.email,
        newRegistrationRecord: handshake.newRegistrationRecord,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        recoverySessionId: handshake.recoverySessionId,
        resetProof: proofFor(handshake, account.email, recoveryPrivateKey),
      },
      undefined,
      { app: createApp({ ...manifestDeps, stores: racedStores }) }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CREDENTIAL_CONFLICT });
    const after = await credentialColumns(account.userId);
    expect(after.opaqueRegistration).toEqual([...FOREIGN_RECORD]);
  });

  it('refuses a reset carrying no proof of the recovery phrase', async () => {
    const { account, cookie } = await registerLoginFull();
    const newPassword = `${account.password} recovered`;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    expect(init.status).toBe(200);
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      recoverySessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post('/auth/recovery/reset/finish', {
      identifier: account.email,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(400);

    // Nothing rotated, nobody notified, and the session predating the attempt
    // is still live — the reset never happened.
    expect(sentPasswordReset.filter((sent) => sent.to === account.email)).toHaveLength(0);
    await expectStatus(get('/t/session', cookie), 200);
  });

  // The pre-run takeover, executed: a stranger who knows only the address runs
  // both rounds and picks the new password. Before the gate this returned 200
  // and handed the stranger a session while the victim's password stopped
  // working; the credential columns are the byte-level proof it no longer does.
  it('refuses a stranger who holds only the email and leaves the credential columns byte-identical', async () => {
    const { account } = await registerWithRecoveryKeypair();
    const before = await credentialColumns(account.userId);

    const handshake = await resetInit(account.email, 'stranger chosen password');
    const finish = await resetFinish(account.email, handshake, FORGED_PROOF);

    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
    // The stranger's OPAQUE record was never installed, so the password they
    // chose authenticates nothing.
    expect(await credentialColumns(account.userId)).toEqual(before);
    // And the victim's own password still logs in.
    const victimLogin = await login(account.email, account.password);
    expect(victimLogin.status).toBe(200);
  });

  it('resets the password when the proof opens the sealed challenge', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const loginRes = await login(account.email, account.password);
    const cookie = sessionCookieOf(loginRes);
    const newPassword = `${account.password} recovered`;

    const handshake = await resetInit(account.email, newPassword);
    const finish = await resetFinish(
      account.email,
      handshake,
      proofFor(handshake, account.email, recoveryPrivateKey)
    );

    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The reset forwards the eviction port through to close staled sockets.
    expect(evictedUserIds).toContain(account.userId);

    // The reset sends the distinct password-reset notice, never the alarming
    // password-changed one, to the account's address.
    expect(sentPasswordReset.filter((sent) => sent.to === account.email)).toHaveLength(1);
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(0);

    await expectStatus(get('/t/session', cookie), 401);
    const relogin = await login(account.email, newPassword);
    expect(relogin.status).toBe(200);
  });

  it('lifts a frozen TOTP ceiling once the reset completes', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const secret = await enrollTotp(sessionCookieOf(await login(account.email, account.password)));
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.twoFactorCeiling;
    await redis.set(
      rateLimitKey(IDENTITY_KEYS.twoFactorCeiling, account.userId)._unsafeUnwrap(),
      maxAttempts,
      { ex: windowSeconds }
    );
    const code = generateTotpCodeSync(secret);
    const frozenPending = sessionCookieOf(await login(account.email, account.password));
    await expectStatus(post('/auth/login/2fa/verify', { code }, frozenPending), 429);

    const newPassword = `${account.password} unfrozen`;
    const handshake = await resetInit(account.email, newPassword);
    const finish = await resetFinish(
      account.email,
      handshake,
      proofFor(handshake, account.email, recoveryPrivateKey)
    );
    expect(finish.status).toBe(200);

    const pending = sessionCookieOf(await login(account.email, newPassword));
    await expectStatus(post('/auth/login/2fa/verify', { code }, pending), 200);
  });

  it('refuses a proof bound to a different registration record', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const before = await credentialColumns(account.userId);
    const handshake = await resetInit(account.email, 'payload swap password');
    const proof = proofFor(handshake, account.email, recoveryPrivateKey);

    // The transport swaps the OPAQUE record after the proof was computed.
    const swapped = await resetInit(account.email, 'a different password');
    const finish = await resetFinish(
      account.email,
      { ...handshake, newRegistrationRecord: swapped.newRegistrationRecord },
      proof
    );

    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
    expect(await credentialColumns(account.userId)).toEqual(before);
  });

  it('refuses a proof bound to a different wrapped private key', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const handshake = await resetInit(account.email, 'wrapped key swap password');
    const proof = proofFor(handshake, account.email, recoveryPrivateKey);

    const finish = await resetFinish(
      account.email,
      handshake,
      proof,
      toBase64(new Uint8Array([1, 2, 3]))
    );

    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });

  it('refuses a replay of a proof already spent on a successful reset', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const handshake = await resetInit(account.email, 'replayed password');
    const proof = proofFor(handshake, account.email, recoveryPrivateKey);
    await expectStatus(resetFinish(account.email, handshake, proof), 200);

    const replay = await resetFinish(account.email, handshake, proof);

    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });

  // A wrong proof consumes the handshake inside the same GETDEL claim, so the
  // nonce is gone before a guess can be repeated against it. Retrying costs a
  // fresh `/init`, which the 3/hour reservation counts.
  it('burns the handshake on a failed proof, refusing the correct proof afterwards', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const handshake = await resetInit(account.email, 'burned handshake password');
    const proof = proofFor(handshake, account.email, recoveryPrivateKey);
    await expectStatus(resetFinish(account.email, handshake, FORGED_PROOF), 400);

    const second = await resetFinish(account.email, handshake, proof);

    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });

  // A single reset cannot tell "the gate works" from "the gate works once":
  // the second reset must mint and seal its own nonce against the unchanged
  // stored public key.
  it('resets twice in a row, each round on its own fresh challenge', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const firstPassword = `${account.password} once`;
    const secondPassword = `${account.password} twice`;

    const first = await resetInit(account.email, firstPassword);
    await expectStatus(
      resetFinish(account.email, first, proofFor(first, account.email, recoveryPrivateKey)),
      200
    );
    const second = await resetInit(account.email, secondPassword);
    await expectStatus(
      resetFinish(account.email, second, proofFor(second, account.email, recoveryPrivateKey)),
      200
    );

    expect(second.sealedChallenge).not.toEqual(first.sealedChallenge);
    const relogin = await login(account.email, secondPassword);
    expect(relogin.status).toBe(200);
  });

  it('answers reset init for an unknown identifier with the same started shape', async () => {
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'brand new password');
    const res = await post('/auth/recovery/reset/init', {
      identifier: `${PREFIX}ghost@identity-routes.test`,
      newRegistrationRequest: serialized,
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'newRegistrationResponse',
      'recoverySessionId',
      'sealedChallenge',
    ]);
  });

  // The challenge is the one field the gate adds to a public response, so it
  // is the one an attacker would probe: an unknown identifier must receive a
  // real sealed challenge — to a decoy recipient only the server can derive —
  // of exactly the shape a registered account gets.
  it('seals a challenge of identical shape for a real account and an unknown identifier', async () => {
    const { account } = await registerWithRecoveryKeypair();
    const { serialized } = await opaqueClientStartRegistration(
      createOpaqueClient(),
      'shape comparison password'
    );
    const initFor = async (identifier: string): Promise<Response> =>
      post('/auth/recovery/reset/init', { identifier, newRegistrationRequest: serialized });

    const knownRes = await initFor(account.email);
    const unknownRes = await initFor(`${PREFIX}phantom@identity-routes.test`);

    expect(unknownRes.status).toBe(knownRes.status);
    const known = await knownRes.json<{ sealedChallenge: string }>();
    const unknown = await unknownRes.json<{ sealedChallenge: string }>();
    expect(Object.keys(unknown).toSorted((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(known).toSorted((a, b) => a.localeCompare(b))
    );
    expect(fromBase64(unknown.sealedChallenge)).toHaveLength(
      fromBase64(known.sealedChallenge).length
    );
    expect(unknown.sealedChallenge).not.toEqual(known.sealedChallenge);
  });

  it('answers an unknown identifier and a wrong proof at finish identically', async () => {
    const { account } = await registerWithRecoveryKeypair();
    const known = await resetInit(account.email, 'parity password');
    const ghost = `${PREFIX}nosuch@identity-routes.test`;
    const unknown = await resetInit(ghost, 'parity password');

    const wrongProof = await resetFinish(account.email, known, FORGED_PROOF);
    const absentAccount = await resetFinish(ghost, unknown, FORGED_PROOF);

    expect(absentAccount.status).toBe(wrongProof.status);
    expect(await absentAccount.text()).toBe(await wrongProof.text());
  });

  // The account vanishes between the two rounds: the proof is genuine, so the
  // gate passes and the flow reaches the lookup that finds nothing.
  it('answers a reset finish for an account deleted after init with no-pending', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const handshake = await resetInit(account.email, 'post-delete password');
    const proof = proofFor(handshake, account.email, recoveryPrivateKey);
    await db.delete(users).where(eq(users.id, account.userId));

    const finish = await resetFinish(account.email, handshake, proof);

    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });

  it('rejects a reset finish whose identifier does not match the handshake', async () => {
    const { account, recoveryPrivateKey } = await registerWithRecoveryKeypair();
    const handshake = await resetInit(account.email, 'another password');

    const finish = await resetFinish(
      `other-${account.email}`,
      handshake,
      proofFor(handshake, account.email, recoveryPrivateKey)
    );

    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });
});

describe('identity routes: recovery/save', () => {
  async function readRecoveryColumns(
    userId: string
  ): Promise<{ blob: number[]; publicKey: number[]; acknowledged: boolean | undefined }> {
    const [row] = await db
      .select({
        recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
        recoveryPublicKey: users.recoveryPublicKey,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
      })
      .from(users)
      .where(eq(users.id, userId));
    return {
      blob: [...(row?.recoveryWrappedPrivateKey ?? [])],
      publicKey: [...(row?.recoveryPublicKey ?? [])],
      acknowledged: row?.hasAcknowledgedPhrase,
    };
  }

  /** Shape-valid save material, distinct from what registration stored. */
  function freshSaveMaterial(fill: number): { blob: Uint8Array; publicKey: Uint8Array } {
    return {
      blob: rewrapAccountKeyForPasswordChange(new Uint8Array(32).fill(fill), new Uint8Array(32)),
      publicKey: generateAccountKeyPair().publicKey,
    };
  }

  interface SaveInitBody {
    ke2: number[];
    recoverySaveSessionId: string;
  }

  /** Round one of the gate: the OPAQUE step-up challenge over the live password. */
  async function saveInit(
    cookie: string,
    password: string
  ): Promise<{ res: Response; body: SaveInitBody; ke3: number[] }> {
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, password);
    const res = await post('/auth/recovery/save/init', { ke1 }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json<SaveInitBody>();
    const { ke3 } = await opaqueClientFinishLogin(stepClient, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    return { res, body, ke3 };
  }

  it('answers the internal error at save init when the row material is sealed under another KEK', async () => {
    const { account, cookie } = await registerLoginFull();
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), account.password);
    const res = await post('/auth/recovery/save/init', { ke1 }, cookie, { env: ROTATED_KEK_ENV });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: ERROR_CODES.INTERNAL });
  });

  /** The whole gated save: prove the password, then carry the material on the finish. */
  async function saveRecovery(
    cookie: string,
    password: string,
    material: { blob: string; publicKey: string }
  ): Promise<Response> {
    const { body, ke3 } = await saveInit(cookie, password);
    return post(
      '/auth/recovery/save/finish',
      {
        ke3,
        recoverySaveSessionId: body.recoverySaveSessionId,
        recoveryWrappedPrivateKey: material.blob,
        recoveryPublicKey: material.publicKey,
      },
      cookie
    );
  }

  function blobsOf(material: { blob: Uint8Array; publicKey: Uint8Array }): {
    blob: string;
    publicKey: string;
  } {
    return { blob: toBase64(material.blob), publicKey: toBase64(material.publicKey) };
  }

  it('persists the recovery-wrapped key and flags phrase acknowledgement', async () => {
    const { account, cookie } = await registerLoginFull();
    const { blob, publicKey } = freshSaveMaterial(7);
    const res = await saveRecovery(cookie, account.password, blobsOf({ blob, publicKey }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const stored = await readRecoveryColumns(account.userId);
    expect(stored.blob).toEqual([...blob]);
    expect(stored.acknowledged).toBe(true);
  });

  it('persists the recovery public key in the same write as the wrapped key', async () => {
    const { account, cookie } = await registerLoginFull();
    const { blob, publicKey } = freshSaveMaterial(2);

    const res = await saveRecovery(cookie, account.password, blobsOf({ blob, publicKey }));

    expect(res.status).toBe(200);
    const stored = await readRecoveryColumns(account.userId);
    expect(stored).toMatchObject({ blob: [...blob], publicKey: [...publicKey] });
  });

  it('writes nothing when the password proof does not verify', async () => {
    const { account, cookie } = await registerLoginFull();
    const before = await readRecoveryColumns(account.userId);
    // A real wrong password cannot produce a KE3 at all — the client's own
    // `finishLogin` throws on the MAC. The reachable wrong-proof is a KE3 built
    // against a DIFFERENT handshake: well-formed bytes, wrong 3DH transcript,
    // which is exactly what the server must refuse.
    const target = await saveInit(cookie, account.password);
    const other = await saveInit(cookie, account.password);
    const { blob, publicKey } = freshSaveMaterial(11);

    const res = await post(
      '/auth/recovery/save/finish',
      {
        ke3: other.ke3,
        recoverySaveSessionId: target.body.recoverySaveSessionId,
        recoveryWrappedPrivateKey: toBase64(blob),
        recoveryPublicKey: toBase64(publicKey),
      },
      cookie
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    const after = await readRecoveryColumns(account.userId);
    expect(after.blob).toEqual(before.blob);
    expect(after.publicKey).toEqual(before.publicKey);
    expect(after.blob).not.toEqual([...blob]);
    expect(after.publicKey).not.toEqual([...publicKey]);
  });

  it('writes nothing when the finish round carries a malformed proof', async () => {
    const { account, cookie } = await registerLoginFull();
    const before = await readRecoveryColumns(account.userId);
    const { body } = await saveInit(cookie, account.password);
    const { blob, publicKey } = freshSaveMaterial(12);

    const res = await post(
      '/auth/recovery/save/finish',
      {
        ke3: [0, 1, 2],
        recoverySaveSessionId: body.recoverySaveSessionId,
        recoveryWrappedPrivateKey: toBase64(blob),
        recoveryPublicKey: toBase64(publicKey),
      },
      cookie
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    const after = await readRecoveryColumns(account.userId);
    expect(after.blob).toEqual(before.blob);
    expect(after.publicKey).toEqual(before.publicKey);
  });

  it('refuses a handshake minted for a different step-up feature', async () => {
    const { account, cookie } = await registerLoginFull();
    const before = await readRecoveryColumns(account.userId);
    // Each feature holds its own Redis key prefix, so a change-password
    // handshake id resolves to nothing here: distinct keys are what stop one
    // proof from being spent on another feature's effect.
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'another password here');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(init.status).toBe(200);
    const initBody = await init.json<{ ke2: number[]; changePasswordSessionId: string }>();
    const { ke3 } = await opaqueClientFinishLogin(
      stepClient,
      initBody.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );

    const res = await post(
      '/auth/recovery/save/finish',
      {
        ke3,
        recoverySaveSessionId: initBody.changePasswordSessionId,
        recoveryWrappedPrivateKey: toBase64(freshSaveMaterial(13).blob),
        recoveryPublicKey: toBase64(generateAccountKeyPair().publicKey),
      },
      cookie
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
    expect(await readRecoveryColumns(account.userId)).toEqual(before);
  });

  it('refuses to replay one proven handshake for a second save', async () => {
    const { account, cookie } = await registerLoginFull();
    const first = freshSaveMaterial(14);
    const { body, ke3 } = await saveInit(cookie, account.password);
    const finishBody = {
      ke3,
      recoverySaveSessionId: body.recoverySaveSessionId,
      recoveryWrappedPrivateKey: toBase64(first.blob),
      recoveryPublicKey: toBase64(first.publicKey),
    };
    await expectStatus(post('/auth/recovery/save/finish', finishBody, cookie), 200);

    const replayed = freshSaveMaterial(15);
    const res = await post(
      '/auth/recovery/save/finish',
      {
        ...finishBody,
        recoveryWrappedPrivateKey: toBase64(replayed.blob),
        recoveryPublicKey: toBase64(replayed.publicKey),
      },
      cookie
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
    const stored = await readRecoveryColumns(account.userId);
    expect(stored.blob).toEqual([...first.blob]);
    expect(stored.publicKey).toEqual([...first.publicKey]);
  });

  // The bricking anti-case: a save that leaves `recovery_public_key` on the
  // superseded phrase's keypair strands the account with a reset challenge no
  // phrase can open. Two real regenerations run back to back, so the stored
  // bytes must equal the second phrase's public half and not the first's —
  // "the column changed" is not enough to pass. This test owns the storage
  // link of the chain only — that each regeneration's `recoveryPublicKey`
  // really is its own phrase's public half is derivation, pinned where the
  // derivation lives, in `packages/crypto`'s account tests.
  it('stores the public key of the phrase being saved, not the superseded one', async () => {
    const { account, cookie } = await registerLoginFull();
    const accountPrivateKey = new Uint8Array(32).fill(3);
    const superseded = await regenerateRecoveryPhrase(accountPrivateKey);
    await expectStatus(
      saveRecovery(cookie, account.password, {
        blob: toBase64(superseded.recoveryWrappedPrivateKey),
        publicKey: toBase64(superseded.recoveryPublicKey),
      }),
      200
    );

    const current = await regenerateRecoveryPhrase(accountPrivateKey);
    await expectStatus(
      saveRecovery(cookie, account.password, {
        blob: toBase64(current.recoveryWrappedPrivateKey),
        publicKey: toBase64(current.recoveryPublicKey),
      }),
      200
    );

    const stored = await readRecoveryColumns(account.userId);
    expect(stored.publicKey).toEqual([...current.recoveryPublicKey]);
    expect(stored.publicKey).not.toEqual([...superseded.recoveryPublicKey]);
    const recovered = await recoverAccountFromMnemonic(
      current.recoveryPhrase,
      Uint8Array.from(stored.blob)
    );
    expect(recovered.accountPrivateKey).toEqual(accountPrivateKey);
  });

  it('rejects a malformed base64 wrapped key with a validation error', async () => {
    const { account, cookie } = await registerLoginFull();
    const res = await saveRecovery(cookie, account.password, {
      blob: '!',
      publicKey: KEY_BLOBS.recoveryPublicKey,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a malformed base64 recovery public key with a validation error', async () => {
    const { account, cookie } = await registerLoginFull();
    const res = await saveRecovery(cookie, account.password, {
      blob: KEY_BLOBS.recoveryWrappedPrivateKey,
      publicKey: '!',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a recovery public key of the wrong length', async () => {
    const { account, cookie } = await registerLoginFull();
    const before = await readRecoveryColumns(account.userId);
    const res = await saveRecovery(cookie, account.password, {
      blob: toBase64(freshSaveMaterial(3).blob),
      publicKey: toBase64(new Uint8Array(31).fill(5)),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    // The two halves are one phrase's keypair: a rejected half must not leave
    // the other one stored against a phrase that cannot open it.
    expect(await readRecoveryColumns(account.userId)).toEqual(before);
  });

  it('rejects a low-order recovery public key', async () => {
    const { account, cookie } = await registerLoginFull();
    const before = await readRecoveryColumns(account.userId);
    const res = await saveRecovery(cookie, account.password, {
      blob: toBase64(freshSaveMaterial(4).blob),
      publicKey: toBase64(new Uint8Array(32)),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    expect(await readRecoveryColumns(account.userId)).toEqual(before);
  });

  it('rejects a recovery-wrapped key of the wrong length', async () => {
    const { account, cookie } = await registerLoginFull();
    const res = await saveRecovery(cookie, account.password, {
      blob: toBase64(new Uint8Array([9, 8, 7])),
      publicKey: toBase64(generateAccountKeyPair().publicKey),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a recovery-wrapped key carrying an unknown version byte', async () => {
    const { account, cookie } = await registerLoginFull();
    const wrongVersion = freshSaveMaterial(6).blob;
    wrongVersion[0] = 0x09;
    const res = await saveRecovery(cookie, account.password, {
      blob: toBase64(wrongVersion),
      publicKey: toBase64(generateAccountKeyPair().publicKey),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a finish body carrying no recovery public key', async () => {
    const { cookie } = await registerLoginFull();
    const res = await post(
      '/auth/recovery/save/finish',
      {
        ke3: [0, 1, 2],
        recoverySaveSessionId: crypto.randomUUID(),
        recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
      },
      cookie
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('denies recovery/save/init without a session (session-class default-deny)', async () => {
    const res = await post('/auth/recovery/save/init', { ke1: [1, 2, 3] });
    expect(res.status).toBe(401);
  });

  it('denies recovery/save/finish without a session (session-class default-deny)', async () => {
    const res = await post('/auth/recovery/save/finish', {
      ke3: [1, 2, 3],
      recoverySaveSessionId: crypto.randomUUID(),
      recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
      recoveryPublicKey: KEY_BLOBS.recoveryPublicKey,
    });
    expect(res.status).toBe(401);
  });

  // The gate is only a gate if the ungated writer is gone. A session-only POST
  // that stored recovery material would make every check above decorative, so
  // its absence is pinned rather than assumed.
  it('no longer exposes a session-only save route', async () => {
    const { account, cookie } = await registerLoginFull();
    const before = await readRecoveryColumns(account.userId);
    const { blob, publicKey } = freshSaveMaterial(16);

    const res = await post(
      '/auth/recovery/save',
      {
        recoveryWrappedPrivateKey: toBase64(blob),
        recoveryPublicKey: toBase64(publicKey),
      },
      cookie
    );

    expect(res.status).toBe(404);
    expect(await readRecoveryColumns(account.userId)).toEqual(before);
  });
});
