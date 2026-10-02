import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { users, wallets } from '@hushbox/db';
import {
  createOpaqueClient,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
} from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, ERROR_CODES } from '@hushbox/shared';
import { WELCOME_CREDIT_NANO_USD } from '../../../billing/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import {
  db,
  enrollTotp,
  post,
  redis,
  registerLoginFull,
  stepUpKe3,
} from '../../routes.integration.setup.js';
import { rateLimitKey } from '../../../../lib/rate-limit/index.js';

interface DeleteHandshake {
  readonly ke2: number[];
  readonly sessionId: string;
  readonly client: ReturnType<typeof createOpaqueClient>;
}

interface FinishExtras {
  readonly acknowledgedForfeitNanoUsd?: string;
  readonly totpCode?: string;
  readonly ke3?: number[];
}

async function deleteInit(cookie: string, password: string): Promise<DeleteHandshake> {
  const client = createOpaqueClient();
  const { ke1 } = await opaqueClientStartLogin(client, password);
  const res = await post('/auth/account/delete/init', { ke1 }, cookie);
  expect(res.status).toBe(200);
  const body = await res.json<{ ke2: number[]; deleteAccountSessionId: string }>();
  return { ke2: body.ke2, sessionId: body.deleteAccountSessionId, client };
}

async function deleteFinish(
  cookie: string,
  init: DeleteHandshake,
  extras: FinishExtras = {}
): Promise<Response> {
  const ke3 = extras.ke3 ?? (await stepUpKe3(init.ke2, init.client));
  return post(
    '/auth/account/delete/finish',
    {
      ke3,
      deleteAccountSessionId: init.sessionId,
      confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      ...(extras.acknowledgedForfeitNanoUsd !== undefined && {
        acknowledgedForfeitNanoUsd: extras.acknowledgedForfeitNanoUsd,
      }),
      ...(extras.totpCode !== undefined && { totpCode: extras.totpCode }),
    },
    cookie
  );
}

async function accountSurvives(userId: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return rows.length === 1;
}

async function setPurchasedBalance(userId: string, balanceNanoUsd: bigint): Promise<void> {
  await db
    .update(wallets)
    .set({ balanceNanoUsd })
    .where(and(eq(wallets.userId, userId), eq(wallets.type, 'purchased')));
}

/** Registration grants the welcome credit into the purchased wallet. */
const WELCOME_BALANCE = WELCOME_CREDIT_NANO_USD.toString();

const FORFEIT_REFUSAL = {
  code: ERROR_CODES.DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED,
  details: { purchasedBalanceNanoUsd: WELCOME_BALANCE },
};

describe('account deletion: the purchased-balance forfeit', () => {
  it('refuses a deletion whose purchased balance exceeds the acknowledged amount', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init, {
      acknowledgedForfeitNanoUsd: (WELCOME_CREDIT_NANO_USD - 1n).toString(),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(FORFEIT_REFUSAL);
    expect(await accountSurvives(account.userId)).toBe(true);
  });

  it('refuses a deletion that acknowledges nothing while a purchased balance exists', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(FORFEIT_REFUSAL);
    expect(await accountSurvives(account.userId)).toBe(true);
  });

  it('refuses a deletion that acknowledges a zero forfeit while a purchased balance exists', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init, { acknowledgedForfeitNanoUsd: '0' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(FORFEIT_REFUSAL);
    expect(await accountSurvives(account.userId)).toBe(true);
  });

  it('deletes when the acknowledged amount equals the purchased balance', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init, { acknowledgedForfeitNanoUsd: WELCOME_BALANCE });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await accountSurvives(account.userId)).toBe(false);
  });

  it('deletes an account with no purchased balance without an acknowledgement', async () => {
    const { account, cookie } = await registerLoginFull();
    await setPurchasedBalance(account.userId, 0n);
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init);

    expect(res.status).toBe(200);
    expect(await accountSurvives(account.userId)).toBe(false);
  });

  it('deletes an account whose purchased balance is negative without an acknowledgement', async () => {
    const { account, cookie } = await registerLoginFull();
    await setPurchasedBalance(account.userId, -5n);
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init);

    expect(res.status).toBe(200);
    expect(await accountSurvives(account.userId)).toBe(false);
  });

  it('spends no deletion attempt on a forfeit refusal', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init);

    expect(res.status).toBe(409);
    expect(
      await redis.get(
        rateLimitKey(IDENTITY_KEYS.deleteAccountLockout, account.userId)._unsafeUnwrap()
      )
    ).toBeNull();
  });

  it('consumes no TOTP code on a forfeit refusal', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const code = generateTotpCodeSync(secret);
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init, { totpCode: code });

    expect(res.status).toBe(409);
    expect(await redis.get(IDENTITY_KEYS.totpUsedCode.buildKey(account.userId, code))).toBeNull();
  });

  it('answers a bad proof as a bad proof, never with the balance', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);

    const res = await deleteFinish(cookie, init, { ke3: [0, 1, 2] });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    expect(await accountSurvives(account.userId)).toBe(true);
  });
});
