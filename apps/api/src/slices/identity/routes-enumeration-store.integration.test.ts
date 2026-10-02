import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  asWrappingPrivateKey,
  createOpaqueClient,
  deriveResetProof,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateAccountKeyPair,
  generateTotpCodeSync,
  openResetChallenge,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES, fromBase64, toBase64 } from '@hushbox/shared';
import {
  KEY_BLOBS,
  PREFIX,
  db,
  enrollTotp,
  login,
  post,
  registerAccount,
  registerLoginFull,
  sessionCookieOf,
  stepUpKe3,
  uniqueAccount,
} from './routes.integration.setup.js';

describe('identity routes: enumeration-safe response shape', () => {
  /**
   * Shape parity is the half these endpoints can pin deterministically: the
   * same status and the same body keys for a known and an unknown identifier.
   * The timing half is structural — the code path is identical from the lockout
   * down and the decoy is sized from the live blob — and its byte-length pin
   * lives in `routes-recovery-password.integration.test.ts`. Wall-clock samples
   * were tried here and measure the runner, not the server.
   */
  async function shapeOf(res: Response): Promise<{ status: number; keys: string[] }> {
    const body = await res.json<Record<string, unknown>>();
    return { status: res.status, keys: Object.keys(body).toSorted((a, b) => a.localeCompare(b)) };
  }

  function ghost(tag: string): string {
    return `${PREFIX}ghost-${tag}@identity-routes.test`;
  }

  it('answers recovery get-wrapped-key with one shape for known and unknown accounts', async () => {
    const account = await registerAccount();
    const known = await shapeOf(
      await post('/auth/recovery/get-wrapped-key', { identifier: account.email })
    );
    const unknown = await shapeOf(
      await post('/auth/recovery/get-wrapped-key', { identifier: ghost('getkey') })
    );
    expect(known).toEqual({ status: 200, keys: ['recoveryWrappedPrivateKey'] });
    expect(unknown).toEqual(known);
  });

  it('answers recovery reset init with one shape for known and unknown accounts', async () => {
    const account = await registerAccount();
    async function resetInit(identifier: string): Promise<{ status: number; keys: string[] }> {
      const { serialized } = await opaqueClientStartRegistration(
        createOpaqueClient(),
        'a fresh password'
      );
      return shapeOf(
        await post('/auth/recovery/reset/init', {
          identifier,
          newRegistrationRequest: serialized,
        })
      );
    }
    const known = await resetInit(account.email);
    const unknown = await resetInit(ghost('reset'));
    expect(known).toEqual({
      status: 200,
      keys: ['newRegistrationResponse', 'recoverySessionId', 'sealedChallenge'],
    });
    expect(unknown).toEqual(known);
  });

  it('answers verification resend with one shape for known and unknown emails', async () => {
    const account = await registerAccount();
    const known = await shapeOf(await post('/auth/verify-email/resend', { email: account.email }));
    const unknown = await shapeOf(
      await post('/auth/verify-email/resend', { email: ghost('resend') })
    );
    expect(known).toEqual({ status: 200, keys: ['success'] });
    expect(unknown).toEqual(known);
  });
});

describe('identity routes: store-outcome and decode edges', () => {
  it('answers already-enabled when the account gets enabled between setup and verify', async () => {
    const { account, cookie } = await registerLoginFull();
    const setup = await post('/auth/2fa/setup', {}, cookie);
    const { secret } = await setup.json<{ secret: string }>();
    // Flip enabled directly so the atomic enable transition matches 0 rows.
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    const verify = await post('/auth/2fa/verify', { code: generateTotpCodeSync(secret) }, cookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.TOTP_ALREADY_ENABLED });
  });

  it('answers not-enabled when TOTP is disabled between disable init and finish', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    // Disable the flag (keep the secret) so the atomic disable matches 0 rows.
    await db.update(users).set({ totpEnabled: false }).where(eq(users.id, account.userId));
    const finish = await post(
      '/auth/2fa/disable/finish',
      {
        ke3,
        code: generateTotpCodeSync(secret),
        disable2FASessionId: initBody.disable2FASessionId,
      },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.TOTP_NOT_ENABLED });
  });

  it('rejects a replayed TOTP code at login 2FA', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const code = generateTotpCodeSync(secret);
    const first = await login(account.email, account.password);
    const firstVerify = await post('/auth/login/2fa/verify', { code }, sessionCookieOf(first));
    expect(firstVerify.status).toBe(200);
    // A second login reusing the same (still-in-window) code hits replay guard.
    const second = await login(account.email, account.password);
    const replay = await post('/auth/login/2fa/verify', { code }, sessionCookieOf(second));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('rejects a change-password finish with a malformed wrapped key', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'decode-edge pw');
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
    const finish = await post(
      '/auth/change-password/finish',
      {
        ke3,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: '!!!not-base64!!!',
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

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

  it('rejects a recovery reset finish with a malformed wrapped key', async () => {
    const pair = generateAccountKeyPair();
    const account = await registerAccount(uniqueAccount(), {
      ...KEY_BLOBS,
      recoveryPublicKey: toBase64(pair.publicKey),
    });
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'decode recovery pw');
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      recoverySessionId: string;
      sealedChallenge: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const malformedWrappedKey = '!!!not-base64!!!';
    const nonce = openResetChallenge(
      asWrappingPrivateKey(pair.privateKey),
      fromBase64(initBody.sealedChallenge)
    );
    // The proof binds the malformed key, so the phrase gate passes and the
    // request lands on the wrapped-key decode this test exists to pin: a failed
    // gate would answer `NO_PENDING_RECOVERY` instead.
    const resetProof = toBase64(
      deriveResetProof(nonce, {
        recoverySessionId: initBody.recoverySessionId,
        canonicalIdentifier: account.email.toLowerCase(),
        newRegistrationRecord: Uint8Array.from(record),
        newPasswordWrappedPrivateKey: malformedWrappedKey,
      })
    );
    const before = await credentialColumns(account.userId);
    const finishBody = {
      identifier: account.email,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: malformedWrappedKey,
      recoverySessionId: initBody.recoverySessionId,
      resetProof,
    };
    const finish = await post('/auth/recovery/reset/finish', finishBody);
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    expect(await credentialColumns(account.userId)).toEqual(before);

    // A body-schema rejection and a decode rejection are byte-identical on the
    // wire, so the status alone cannot say which one answered. Replaying the
    // same request can: reaching the decode means the claim already consumed
    // the handshake, and a request refused at the validator never touches it.
    const replay = await post('/auth/recovery/reset/finish', finishBody);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });
});
