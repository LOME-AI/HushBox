import { describe, expect, it } from 'vitest';
import {
  createOpaqueClient,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, ERROR_CODES } from '@hushbox/shared';
import { okAsync } from '../../lib/result/index.js';
import { WELCOME_CREDIT_NANO_USD } from '../billing/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { STEP_UP_GATES, createStepUpFinishFlow } from './domain/session/step-up.js';
import {
  KEY_BLOBS,
  enrollTotp,
  post,
  redis,
  registerLoginFull,
  stepUpKe3,
  wrongCode,
} from './routes.integration.setup.js';

// Registration grants the welcome credit into the purchased wallet, so a deletion
// here acknowledges that amount as forfeited.
const ACKNOWLEDGED_FORFEIT = WELCOME_CREDIT_NANO_USD.toString();

const CAP = IDENTITY_KEYS.stepUpLockout.maxAttempts;
const DELETE_CAP = IDENTITY_KEYS.deleteAccountInitLockout.maxAttempts;

async function stepUpHandshake(
  password: string
): Promise<{ ke1: number[]; client: ReturnType<typeof createOpaqueClient> }> {
  const client = createOpaqueClient();
  const { ke1 } = await opaqueClientStartLogin(client, password);
  return { ke1, client };
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  const body = await res.json<{ code: string; details: { retryAfterSeconds: number } }>();
  expect(body.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
  expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
}

interface DeleteHandshake {
  readonly ke2: number[];
  readonly sessionId: string;
  readonly client: ReturnType<typeof createOpaqueClient>;
}

/** One init-only deletion guess. */
async function deleteInit(cookie: string, password = 'not the password'): Promise<Response> {
  const { ke1 } = await stepUpHandshake(password);
  return post('/auth/account/delete/init', { ke1 }, cookie);
}

/** The same round, kept open so a finish round can follow it. */
async function deleteHandshake(cookie: string, password: string): Promise<DeleteHandshake> {
  const { ke1, client } = await stepUpHandshake(password);
  const res = await post('/auth/account/delete/init', { ke1 }, cookie);
  expect(res.status).toBe(200);
  const body = await res.json<{ ke2: number[]; deleteAccountSessionId: string }>();
  return { ke2: body.ke2, sessionId: body.deleteAccountSessionId, client };
}

async function deleteFinish(
  cookie: string,
  init: DeleteHandshake,
  extra: { ke3?: number[]; confirmationPhrase?: string; totpCode?: string } = {}
): Promise<Response> {
  return post(
    '/auth/account/delete/finish',
    {
      ke3: extra.ke3 ?? (await stepUpKe3(init.ke2, init.client)),
      deleteAccountSessionId: init.sessionId,
      acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
      confirmationPhrase: extra.confirmationPhrase ?? DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      ...(extra.totpCode !== undefined && { totpCode: extra.totpCode }),
    },
    cookie
  );
}

/** Spends deletion's whole budget through init-only guesses. */
async function exhaustDeletion(cookie: string, attempts: number = DELETE_CAP): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const admitted = await deleteInit(cookie);
    expect(admitted.status).toBe(200);
  }
}

/** One init-only guess — the whole of the attack the shared gate exists to meter. */
async function saveInit(cookie: string, password = 'not the password'): Promise<Response> {
  const handshake = await saveHandshake(cookie, password);
  return handshake.res;
}

/** The same round, keeping the client so a verified finish can follow. */
async function saveHandshake(
  cookie: string,
  password: string
): Promise<{ res: Response; client: ReturnType<typeof createOpaqueClient> }> {
  const { ke1, client } = await stepUpHandshake(password);
  return { res: await post('/auth/recovery/save/init', { ke1 }, cookie), client };
}

/** Spends the whole shared budget through init-only guesses. */
async function exhaust(cookie: string, attempts: number = CAP): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const admitted = await saveInit(cookie);
    expect(admitted.status).toBe(200);
  }
}

/**
 * The step-up guessing gate, exercised at the round it is spent at: `init`.
 *
 * OPAQUE answers the password guess in the KE2 the init round returns — the
 * client verifies it locally and a wrong password never produces a finish call
 * — so an attacker enumerating passwords calls `init` and nothing else. Every
 * test here therefore attacks through `init` alone, and the password it sends
 * is irrelevant: the server cannot tell a wrong one from a right one at this
 * round, which is precisely why the attempt is charged here.
 */
describe('identity routes: the shared step-up guessing gate', () => {
  async function changePasswordInit(cookie: string, password: string): Promise<Response> {
    const { ke1 } = await stepUpHandshake(password);
    const { serialized } = await opaqueClientStartRegistration(
      createOpaqueClient(),
      'a brand new password'
    );
    return post('/auth/change-password/init', { ke1, newRegistrationRequest: serialized }, cookie);
  }

  async function disable2faInit(cookie: string, password: string): Promise<Response> {
    const { ke1 } = await stepUpHandshake(password);
    return post('/auth/2fa/disable/init', { ke1 }, cookie);
  }

  it('refuses the attempt past its cap to a caller that only ever calls init', async () => {
    const { cookie } = await registerLoginFull();

    await exhaust(cookie);

    await expectRefused(await saveInit(cookie));
  });

  it('admits exactly its cap when more than a cap of inits race', async () => {
    // Offered ALL AT ONCE, never in sequence: a cap that only holds when
    // requests arrive one at a time is not a cap (CODE-RULES §Security).
    const { cookie } = await registerLoginFull();
    const overCap = 4;

    const responses = await Promise.all(
      Array.from({ length: CAP + overCap }, async () => saveInit(cookie))
    );
    const statuses = responses.map((res) => res.status);

    expect(statuses.filter((status) => status !== 429)).toHaveLength(CAP);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overCap);
  });

  it('spends one budget across change-password, 2FA-disable and recovery-save', async () => {
    const { account, cookie } = await registerLoginFull();
    await enrollTotp(cookie);
    await exhaust(cookie, CAP - 1);

    // The last of the budget goes to a DIFFERENT flow than the ones that spent
    // the rest, and the third flow finds nothing left.
    const lastOfTheBudget = await changePasswordInit(cookie, account.password);
    expect(lastOfTheBudget.status).toBe(200);

    await expectRefused(await disable2faInit(cookie, account.password));
    await expectRefused(await changePasswordInit(cookie, account.password));
    await expectRefused(await saveInit(cookie));
  });

  it('clears the counter on a verified step-up', async () => {
    const { account, cookie } = await registerLoginFull();
    await exhaust(cookie, CAP - 1);

    // The last attempt of the budget is a real one, carried through to a
    // verified finish.
    const init = await saveHandshake(cookie, account.password);
    expect(init.res.status).toBe(200);
    const body = await init.res.json<{ ke2: number[]; recoverySaveSessionId: string }>();
    const finish = await post(
      '/auth/recovery/save/finish',
      {
        ke3: await stepUpKe3(body.ke2, init.client),
        recoverySaveSessionId: body.recoverySaveSessionId,
        recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
        recoveryPublicKey: KEY_BLOBS.recoveryPublicKey,
      },
      cookie
    );
    expect(finish.status).toBe(200);

    // A full fresh budget, which only a cleared counter can admit.
    await exhaust(cookie);
    await expectRefused(await saveInit(cookie));
  });

  it('counts each user against their own budget', async () => {
    const exhausted = await registerLoginFull();
    const neighbour = await registerLoginFull();

    await exhaust(exhausted.cookie);
    await expectRefused(await saveInit(exhausted.cookie));

    const neighbourInit = await saveInit(neighbour.cookie);
    expect(neighbourInit.status).toBe(200);
  });

  it('leaves account deletion on its own counter, spent and bounded separately', async () => {
    // Exhausting this gate must not reach deletion — deletion arms a 24-hour
    // freeze, a severity no unrelated flow's fumble may trigger. What deletion
    // gets instead is a budget of its own, NOT a free one: while this gate was
    // the only init-side meter, an exhausted attacker simply moved to
    // `delete/init` and guessed there without limit.
    const { cookie } = await registerLoginFull();
    await exhaust(cookie);
    await expectRefused(await saveInit(cookie));

    await exhaustDeletion(cookie);

    await expectRefused(await deleteInit(cookie));
  });
});

/**
 * Account deletion's own init-side guessing gate.
 *
 * Deletion stays off the shared counter above so no unrelated flow's password
 * fumble can arm its 24-hour freeze — but its init round mints the same OPAQUE
 * answer as any other step-up, so leaving it unmetered left a session-holding
 * attacker an unbounded password oracle. It therefore meters at `init` too, on
 * a key of its own, and clears on a proven password exactly as the shared gate
 * does. Its finish round is untouched: the confirmation-phrase carve-out and
 * the 24-hour hard lock both live there.
 */
describe('identity routes: the account-deletion init guessing gate', () => {
  it('refuses a deletion init past its cap to a caller that only ever calls init', async () => {
    const { cookie } = await registerLoginFull();

    await exhaustDeletion(cookie);

    await expectRefused(await deleteInit(cookie));
  });

  it('admits exactly its cap when more than a cap of deletion inits race', async () => {
    const { cookie } = await registerLoginFull();
    const overCap = 4;

    const responses = await Promise.all(
      Array.from({ length: DELETE_CAP + overCap }, async () => deleteInit(cookie))
    );
    const statuses = responses.map((res) => res.status);

    expect(statuses.filter((status) => status !== 429)).toHaveLength(DELETE_CAP);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overCap);
  });

  it('clears the counter on a verified deletion step-up', async () => {
    // A wrong second factor keeps the account alive while still proving the
    // password: the proof is what the counter clears on, not the deletion.
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    await exhaustDeletion(cookie, DELETE_CAP - 1);
    const init = await deleteHandshake(cookie, account.password);

    const finish = await deleteFinish(cookie, init, { totpCode: wrongCode(secret) });
    expect(finish.status).toBe(400);

    // The budget was fully spent by that init; only a cleared counter admits.
    const afterProof = await deleteInit(cookie);
    expect(afterProof.status).toBe(200);
  });

  it('leaves the counter unspent after a wrong confirmation phrase', async () => {
    // A wrong phrase means the password was RIGHT — the client cannot produce a
    // finish call otherwise — so it must not cost a guess, the same carve-out
    // the finish-side gate has always made.
    const { account, cookie } = await registerLoginFull();
    await exhaustDeletion(cookie, DELETE_CAP - 1);
    const init = await deleteHandshake(cookie, account.password);

    const finish = await deleteFinish(cookie, init, { confirmationPhrase: 'delete my acount' });
    expect(finish.status).toBe(400);

    const afterWrongPhrase = await deleteInit(cookie);
    expect(afterWrongPhrase.status).toBe(200);
  });

  it('keeps the counter spent when the wrong phrase carries a bad proof', async () => {
    // The carve-out is paid for by the proof, never by the phrase: junk KE3
    // bytes prove nothing, so this attempt stays charged.
    const { cookie } = await registerLoginFull();
    await exhaustDeletion(cookie, DELETE_CAP - 1);
    const init = await deleteHandshake(cookie, 'not the password');

    const finish = await deleteFinish(cookie, init, {
      ke3: [0, 1, 2],
      confirmationPhrase: 'delete my acount',
    });
    expect(finish.status).toBe(400);

    await expectRefused(await deleteInit(cookie));
  });
});

/**
 * The finish flow refunds the gate its own init spent — the other half of the
 * pair `startGuardedStepUp` charges. A flow carrying a gate of its own would
 * otherwise meter on one counter and refund another, leaving a proven password
 * charged forever; deletion is the gate that is not the shared one, so it is
 * what the pairing is exercised through here.
 */
describe('identity domain: the step-up finish flow refunds its own gate', () => {
  /** A verified finish driven straight through the flow, on deletion's gate. */
  async function finishOnDeletionGate(userId: string, init: DeleteHandshake): Promise<void> {
    const flow = createStepUpFinishFlow<null>({
      redis,
      gate: STEP_UP_GATES.deleteAccount,
      userId,
      stepUpSessionId: init.sessionId,
      ke3: await stepUpKe3(init.ke2, init.client),
      onVerified: () => okAsync(null),
    });
    const claimed = await flow.claim();
    expect(claimed._unsafeUnwrap()).toBe(true);
    const outcome = await flow.execute();
    expect(outcome._unsafeUnwrap().kind).toBe('verified');
  }

  it('clears the gate its own init spent', async () => {
    const { account, cookie } = await registerLoginFull();
    await exhaustDeletion(cookie, DELETE_CAP - 1);
    const init = await deleteHandshake(cookie, account.password);

    await finishOnDeletionGate(account.userId, init);

    // The budget was fully spent by that init; only a cleared counter admits.
    const afterProof = await deleteInit(cookie);
    expect(afterProof.status).toBe(200);
  });

  it('leaves an unrelated flow gate spent', async () => {
    const { account, cookie } = await registerLoginFull();
    await exhaust(cookie);
    await exhaustDeletion(cookie, DELETE_CAP - 1);
    const init = await deleteHandshake(cookie, account.password);

    await finishOnDeletionGate(account.userId, init);

    await expectRefused(await saveInit(cookie));
  });
});
