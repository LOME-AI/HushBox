import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  conversations,
  jobs,
  ledgerEntries,
  messages,
  users,
  wallets,
} from '@hushbox/db';
import {
  createOpaqueClient,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
} from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, ERROR_CODES } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../media/index.js';
import { WELCOME_CREDIT_NANO_USD } from '../billing/index.js';
import {
  PREFIX,
  createApp,
  db,
  deletionPurge,
  enrollTotp,
  evictedUserIds,
  get,
  manifestDeps,
  post,
  recordCaptures,
  recordErrorLines,
  redis,
  registerAccount,
  registerLoginFull,
  scrubbedCaptureTags,
  sentAccountDeleted,
  testEnv,
  stepUpKe3,
} from './routes.integration.setup.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';
import type { ExecutionContext } from 'hono';

// Registration grants the welcome credit into the purchased wallet, so a deletion
// here acknowledges that amount as forfeited.
const ACKNOWLEDGED_FORFEIT = WELCOME_CREDIT_NANO_USD.toString();

// This file seeds `conversations` (a cross-slice table) via `seedOwnedMedia`, so
// it reclaims them itself: a PREFIX-scoped delete whose cascade clears the
// membership rows the shared `users` delete would otherwise trip over. Registered
// here (not in the shared setup) it runs BEFORE the setup module's afterAll
// (vitest runs afterAll LIFO), and keeps the cross-slice write inside a
// `*.test.ts` file, which the single-writer-per-table arch rule exempts.
afterAll(async () => {
  const prefixPattern = `${PREFIX}%`;
  await db
    .delete(conversations)
    .where(
      sql`${conversations.userId} IN (SELECT ${users.id} FROM ${users} WHERE ${users.username} LIKE ${prefixPattern})`
    );
});

describe('identity routes: account-deletion request', () => {
  async function deleteInit(
    cookie: string,
    password: string
  ): Promise<{ ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> }> {
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, password);
    const res = await post('/auth/account/delete/init', { ke1 }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json<{ ke2: number[]; deleteAccountSessionId: string }>();
    return { ke2: body.ke2, sessionId: body.deleteAccountSessionId, client };
  }

  async function deleteFinish(
    cookie: string,
    init: { ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> },
    extra: { ke3?: number[]; confirmationPhrase?: string; totpCode?: string } = {}
  ): Promise<Response> {
    const ke3 = extra.ke3 ?? (await stepUpKe3(init.ke2, init.client));
    return post(
      '/auth/account/delete/finish',
      {
        ke3,
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: extra.confirmationPhrase ?? DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        ...(extra.totpCode !== undefined && { totpCode: extra.totpCode }),
      },
      cookie
    );
  }

  /** Seeds an owned conversation carrying one media content item. */
  async function seedOwnedMedia(userId: string): Promise<{ storageKey: string }> {
    const conversation = await seedConversationWithEpoch(db, {
      userId,
      title: new Uint8Array([1]),
      epochPublicKey: new Uint8Array([1]),
      confirmationHash: new Uint8Array([1]),
    });
    await db
      .insert(conversationMembers)
      .values({ conversationId: conversation.conversationId, userId, visibleFromEpoch: 1 });
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation.conversationId,
        senderType: 'user',
        senderId: userId,
        wrappedContentKey: new Uint8Array([1]),
        epochNumber: 1,
        sequenceNumber: 1,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('message seed failed');
    const storageKey = `media/${conversation.conversationId}/${message.id}/${crypto.randomUUID()}`;
    await db.insert(contentItems).values({
      messageId: message.id,
      contentType: 'image',
      storageKey,
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    return { storageKey };
  }

  async function reclaimJobsFor(userId: string): Promise<{ shard: string; payload: unknown }[]> {
    return db
      .select({ shard: jobs.shard, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
  }

  it('hard-deletes the account after a verified step-up: rows gone, media reclaimed, session dead', async () => {
    const { account, cookie } = await registerLoginFull();
    const { storageKey } = await seedOwnedMedia(account.userId);
    const userAgent = `${PREFIX}-delete-agent-${crypto.randomUUID()}`;
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);

    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3,
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { headers: { 'user-agent': userAgent, 'cf-connecting-ip': '198.51.100.4' } }
    );
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The users row is gone; the deletion executed synchronously.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    // The anonymous forensic event recorded the request fingerprint only.
    const events = await db
      .select({ ipAddress: accountDeletionEvents.ipAddress })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, userAgent));
    expect(events).toEqual([{ ipAddress: '198.51.100.4' }]);
    // The bulk-shard reclaim job carries exactly the owned storage keys.
    const jobRows = await reclaimJobsFor(account.userId);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.shard).toBe('bulk');
    expect((jobRows[0]?.payload as { storageKeys: string[] }).storageKeys).toEqual([storageKey]);
    // Post-commit tail: eviction fan-out + confirmation to the captured email.
    expect(evictedUserIds).toContain(account.userId);
    expect(sentAccountDeleted).toContainEqual({ to: account.email });
    // Prompt cleanup: a committed pending bulk row must not linger where a
    // concurrent jobs-suite bulk pass could claim it.
    await db
      .delete(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.userId}`
        )
      );
    // The old cookie is dead (pw-changed watermark stales it) — repeat-finish
    // cannot even reach the flow again.
    const repeat = await post('/auth/account/delete/init', { ke1: [1, 2, 3] }, cookie);
    expect(repeat.status).toBe(401);
  });

  it('does not freeze deletion for a day after a short fumble under the guessing cap', async () => {
    const { account, cookie } = await registerLoginFull();
    const { maxAttempts } = IDENTITY_KEYS.deleteAccountLockout;
    for (let attempt = 0; attempt < maxAttempts - 1; attempt += 1) {
      const init = await deleteInit(cookie, account.password);
      const bad = await post(
        '/auth/account/delete/finish',
        {
          ke3: [0, 1, 2],
          deleteAccountSessionId: init.sessionId,
          acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      );
      expect(bad.status).toBe(401);
    }
    // No hard lock has engaged, so a correct step-up still deletes the account.
    expect(
      await redis.get(IDENTITY_KEYS.deleteAccountHardLock.buildKey(account.userId))
    ).toBeNull();
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
  });

  it('enqueues no reclaim job for an account that stored no media', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    expect(await reclaimJobsFor(account.userId)).toHaveLength(0);
  });

  it('answers success when the hard-lock delete fails, an account already deleted', async () => {
    const { account, cookie } = await registerLoginFull();
    const hardLockKey = IDENTITY_KEYS.deleteAccountHardLock.buildKey(account.userId);
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    const realFetch = globalThis.fetch;
    // The lock delete rides the REST transport as a named command, so the
    // transport is where one is made to fail. Matching the lock's own key
    // leaves every other command the deletion needs — the counter clear
    // included — running.
    const refused: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init_) => {
      const body = init_?.body;
      if (typeof body === 'string' && body.includes('["del"') && body.includes(hardLockKey)) {
        refused.push(hardLockKey);
        throw new Error('redis del refused');
      }
      return realFetch(input, init_);
    });

    try {
      const finish = await post(
        '/auth/account/delete/finish',
        {
          ke3,
          deleteAccountSessionId: init.sessionId,
          acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      );

      expect(finish.status).toBe(200);
      expect(await finish.json()).toEqual({ success: true });
    } finally {
      fetchSpy.mockRestore();
    }
    // The account really is gone — the caller's success is the truth, and the
    // refused delete is what makes the case the one under test rather than a
    // transport that never carried it.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    expect(refused).toContain(hardLockKey);
  });

  it('rolls the whole deletion back when a step inside the transaction fails', async () => {
    const { account, cookie } = await registerLoginFull();
    const userAgent = `${PREFIX}-rollback-agent-${crypto.randomUUID()}`;
    const failingApp = createApp({
      ...manifestDeps,
      deletionPurge: () => ({
        ...deletionPurge,
        detachMessageSendersWithinTx: () => {
          throw new Error('injected failure before the users delete');
        },
      }),
    });
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { app: failingApp, headers: { 'user-agent': userAgent } }
    );
    expect(finish.status).toBe(503);

    // Atomicity: the account survives untouched — no event, no job, live session.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(1);
    expect(
      await db
        .select({ id: accountDeletionEvents.id })
        .from(accountDeletionEvents)
        .where(eq(accountDeletionEvents.userAgent, userAgent))
    ).toHaveLength(0);
    expect(await reclaimJobsFor(account.userId)).toHaveLength(0);
    const stillAlive = await get('/t/session', cookie);
    expect(stillAlive.status).toBe(200);
  });

  it('nudges no dispatcher when the deletion has no media to reclaim', async () => {
    const { account, cookie } = await registerLoginFull();
    const wakes: string[] = [];
    const waited: Promise<unknown>[] = [];
    // No wake-specific dependency: the wake rides the media-reclaim ENQUEUE,
    // which a deletion with no owned content never performs — so the boundary
    // discharges nothing. The composed-root suite covers the media-owning
    // deletion that does leave a shard.
    const wakingEnv = {
      ...testEnv,
      JOB_DISPATCHER: {
        idFromName: (name: string) => name,
        get: (id: unknown) => ({
          fetch: (): Promise<unknown> => {
            wakes.push(String(id));
            return Promise.resolve(new Response(null, { status: 200 }));
          },
        }),
      },
    };
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
      passThroughOnException: () => {},
    } as ExecutionContext;
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { executionCtx, env: wakingEnv }
    );
    expect(finish.status).toBe(200);
    await Promise.all(waited);
    expect(wakes).toEqual([]);
  });

  it('treats a vanished user after a verified step-up as a defect (500)', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await deleteFinish(cookie, init, { ke3 });
    expect(res.status).toBe(500);
  });

  it('answers the typed stranded error, deleting nothing, when the stored secret is under a foreign TOTP key', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const res = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        totpCode: generateTotpCodeSync(secret),
      },
      cookie,
      { env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' } } // gitleaks:allow
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: ERROR_CODES.TOTP_SECRET_STRANDED });
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, account.userId));
    expect(rows).toHaveLength(1);
  });

  it('names the stranded user and the deletion gate on the event that leaves the process', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const { captures } = await recordCaptures(async (app) =>
      post(
        '/auth/account/delete/finish',
        {
          ke3: await stepUpKe3(init.ke2, init.client),
          deleteAccountSessionId: init.sessionId,
          acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
          totpCode: generateTotpCodeSync(secret),
        },
        cookie,
        {
          app,
          env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' }, // gitleaks:allow
        }
      )
    );

    expect(scrubbedCaptureTags(captures)).toEqual({
      errorCode: 'totp_secret_stranded',
      totpStrandedUserId: account.userId,
      totpStrandedRoute: '/auth/account/delete/finish',
    });
  });

  it('pages the operator once under the stranded fingerprint at account deletion, answering the same typed error', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const { response, lines } = await recordErrorLines(async () =>
      post(
        '/auth/account/delete/finish',
        {
          ke3: await stepUpKe3(init.ke2, init.client),
          deleteAccountSessionId: init.sessionId,
          acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
          totpCode: generateTotpCodeSync(secret),
        },
        cookie,
        { env: { ...testEnv, TOTP_ENCRYPTION_SECRET: 'rotated-totp-at-least-32-characters-long' } } // gitleaks:allow
      )
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: ERROR_CODES.TOTP_SECRET_STRANDED });
    expect(
      lines.filter((line) => line.msg === 'error.captured').map((line) => line.errorCode)
    ).toEqual(['totp_secret_stranded']);
    expect(lines).toContainEqual(
      expect.objectContaining({
        errorCode: 'totp_secret_stranded',
        userId: account.userId,
        route: '/auth/account/delete/finish',
      })
    );
  });

  it('hard-deletes the account after a verified step-up and valid TOTP code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
  });

  it('treats a 2FA-enabled account with no configured secret as a defect (500) at deletion', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    await db.update(users).set({ totpSecretEncrypted: null }).where(eq(users.id, account.userId));
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(500);
  });

  describe('re-registration after deletion', () => {
    async function purchasedWallet(userId: string): Promise<{ id: string; balance: bigint }> {
      const [wallet] = await db
        .select({ id: wallets.id, balance: wallets.balanceNanoUsd })
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.type, 'purchased')));
      if (!wallet) throw new Error('no purchased wallet for user');
      return wallet;
    }

    /**
     * The welcome credit is granted AGAIN, and that is the decision, not a leak
     * to plug: deletion is hard, so nothing survives it that could remember the
     * email — deduping the grant would mean retaining a record of a deleted
     * account, which is the privacy promise this whole path exists to keep.
     * The bound on the loop is the global welcome/trial budget, never grant
     * history. Anyone "fixing" this is reversing a product decision.
     */
    it('grants the welcome credit again to an email that re-registers after deletion', async () => {
      const { account, cookie } = await registerLoginFull();
      const granted = await purchasedWallet(account.userId);
      expect(granted.balance).toBe(WELCOME_CREDIT_NANO_USD);
      const init = await deleteInit(cookie, account.password);
      const res = await deleteFinish(cookie, init);
      expect(res.status).toBe(200);
      expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);

      const reregistered = await registerAccount(account);

      // A surviving row would take the duplicate-email branch, whose
      // enumeration-proof fake success returns a userId it never wrote.
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, account.email));
      expect(row?.id).toBe(reregistered.userId);
      const regranted = await purchasedWallet(reregistered.userId);
      expect(regranted.id).not.toBe(granted.id);
      expect(regranted.balance).toBe(WELCOME_CREDIT_NANO_USD);
      const legs = await db
        .select({ amountNanoUsd: ledgerEntries.amountNanoUsd, kind: ledgerEntries.kind })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.walletId, regranted.id));
      expect(legs).toEqual([{ amountNanoUsd: WELCOME_CREDIT_NANO_USD, kind: 'promo' }]);
    });
  });
});
