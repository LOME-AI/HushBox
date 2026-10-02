import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  jobs,
  messages,
  newsletterSubscribers,
  payments,
  sharedLinks,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import {
  createAppJobRegistry,
  createJobWakeCollector,
  enqueueWithinTx,
  grantJobWakes,
} from '../../../../lib/jobs/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE, createMediaReclaimUserJob } from '../../../media/index.js';
import {
  captureContentStorageKeysWithinTx,
  deleteForeignMessageContentWithinTx,
  detachMessageSendersWithinTx,
} from '../../../chat/index.js';
import { ASSISTANT_SENDER_ID } from '../../../chat/domain/settlement/settlement.js';
import { createIdentityStores } from '../../adapters/stores.js';
import { IDENTITY_KEYS } from '../keys.js';
import { executeAccountDeletion } from './deletion.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../../test-support/link-credential.js';
import type { Storage } from '../../../media/index.js';
import type { AccountDeletionPurge, EvictUserPort, IdentityUsersStore } from '../../ports/index.js';
import type { AccountDeletionArgs } from './deletion.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Upstash vars are required for deletion executor tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const stores = createIdentityStores(db);

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, so the next file to land on that slot sees whatever rows this one
 * leaves behind.
 */
const PREFIX = `zd${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

/**
 * Enqueue-only registry: the reclaim handler runs in the dispatcher DO, never
 * here, so the storage the registration demands is a dead placeholder — the
 * enqueue path reads only the schema/lease/shard metadata.
 */
const reclaimRegistry = createAppJobRegistry([
  createMediaReclaimUserJob({ resolveStorage: () => ({}) as Storage }),
]);

const sentDeleted: string[] = [];
const evicted: string[] = [];

function purge(overrides: Partial<AccountDeletionPurge> = {}): AccountDeletionPurge {
  return {
    captureContentStorageKeysWithinTx,
    deleteForeignMessageContentWithinTx,
    detachMessageSendersWithinTx,
    enqueueMediaReclaimWithinTx: async (tx, args) => {
      await enqueueWithinTx(tx, reclaimRegistry, {
        type: MEDIA_RECLAIM_USER_JOB_TYPE,
        payload: args,
      });
    },
    ...overrides,
  };
}

const evictUser: EvictUserPort = {
  evictUser: (userId) => {
    evicted.push(userId);
    return Promise.resolve();
  },
};

function executorArgs(
  userId: string,
  overrides: Partial<AccountDeletionPurge> = {}
): AccountDeletionArgs & { readonly userAgent: string } {
  return {
    redis,
    store: stores.users,
    db,
    purge: purge(overrides),
    accountDeletedEmail: {
      sendAccountDeletedEmail: (args: { readonly to: string }) => {
        sentDeleted.push(args.to);
        return okAsync();
      },
    },
    evictUser,
    userId,
    ipAddress: '203.0.113.7',
    // Per-call marker: deletion events are anonymous, so a unique userAgent
    // is each test's only handle on its own rows.
    userAgent: `${PREFIX}-agent-${crypto.randomUUID()}`,
    now: new Date(),
  };
}

async function seedUser(): Promise<{ id: string; email: string }> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `${PREFIX}u${String(counter)}@deletion-executor.test`,
      username: `${PREFIX}u${String(counter)}`,
      opaqueRegistration: BYTES,
      opaqueServerMaterial: BYTES,
      opaqueKekFingerprint: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
      recoveryPublicKey: BYTES,
    })
    .returning({ id: users.id, email: users.email });
  if (!row) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row;
}

const CONSENT_IP = '203.0.113.9';
const CONSENT_TEXT_VERSION = '2026-07-17';

async function seedSubscription(userId: string): Promise<{ id: string; email: string }> {
  counter += 1;
  const [row] = await db
    .insert(newsletterSubscribers)
    .values({
      email: `${PREFIX}n${String(counter)}@deletion-executor.test`,
      status: 'subscribed',
      userId,
      consentSource: 'marketing_site',
      consentIp: CONSENT_IP,
      consentTextVersion: CONSENT_TEXT_VERSION,
      unsubscribeToken: `${PREFIX}-unsub-${crypto.randomUUID()}`,
    })
    .returning({ id: newsletterSubscribers.id, email: newsletterSubscribers.email });
  if (!row) throw new Error('subscription seed failed');
  return row;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  // Rotated, so deletion is proven over a conversation whose `current_epoch`
  // names a later epoch and whose chain has to cascade with it.
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: ownerUserId,
    title: BYTES,
    currentEpoch: 3,
  });
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId: ownerUserId, visibleFromEpoch: 1 });
  return conversationId;
}

let sequence = 0;

async function seedMessage(
  conversationId: string,
  senderId: string,
  senderType: 'user' | 'assistant' = 'user'
): Promise<string> {
  sequence += 1;
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      senderType,
      senderId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: sequence,
    })
    .returning({ id: messages.id });
  if (!row) throw new Error('message seed failed');
  return row.id;
}

function mediaKey(): string {
  return `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
}

async function seedMediaItem(messageId: string, storageKey: string): Promise<void> {
  await db.insert(contentItems).values({
    messageId,
    contentType: 'image',
    storageKey,
    mimeType: 'image/png',
    sizeBytes: 3,
  });
}

async function seedTextItem(messageId: string): Promise<void> {
  await db.insert(contentItems).values({
    messageId,
    contentType: 'text',
    encryptedBlob: BYTES,
  });
}

async function messageState(
  messageId: string
): Promise<{ senderId: string | null; deletedAt: Date | null; contentItemCount: number }> {
  const [row] = await db
    .select({ senderId: messages.senderId, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!row) throw new Error('message not found');
  const items = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(eq(contentItems.messageId, messageId));
  return { ...row, contentItemCount: items.length };
}

async function seedFinancialRows(
  userId: string
): Promise<{ paymentId: string; usageId: string; walletId: string }> {
  const [wallet] = await db
    .insert(wallets)
    .values({ userId, type: 'purchased' })
    .returning({ id: wallets.id });
  const [payment] = await db
    .insert(payments)
    .values({
      userId,
      amountNanoUsd: 5_000_000_000n,
      idempotencyKey: `${PREFIX}-pay-${crypto.randomUUID()}`,
    })
    .returning({ id: payments.id });
  const [usage] = await db
    .insert(usageRecords)
    .values({
      payerUserId: userId,
      runId: crypto.randomUUID(),
      modelId: 'test/model',
      providerName: 'test',
      modality: 'text',
      costNanoUsd: 1000n,
      idempotencyKey: `${PREFIX}-usage-${crypto.randomUUID()}`,
    })
    .returning({ id: usageRecords.id });
  if (!payment || !usage || !wallet) throw new Error('financial seed failed');
  return { paymentId: payment.id, usageId: usage.id, walletId: wallet.id };
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db
      .delete(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
  }
  await db.delete(accountDeletionEvents).where(like(accountDeletionEvents.userAgent, `${PREFIX}%`));
  await db.delete(payments).where(like(payments.idempotencyKey, `${PREFIX}%`));
  await db.delete(usageRecords).where(like(usageRecords.idempotencyKey, `${PREFIX}%`));
  await db.delete(newsletterSubscribers).where(like(newsletterSubscribers.email, `${PREFIX}%`));
  await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await db.$client.end();
});

describe('executeAccountDeletion', () => {
  it('hard-deletes the account in one transaction and reclaims, revokes, and notifies after commit', async () => {
    const account = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(account.id);
    const foreign = await seedConversation(other.id);
    // Membership + a message in the OTHER user's conversation.
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, userId: account.id, visibleFromEpoch: 1 });
    const foreignMessage = await seedMessage(foreign, account.id);
    const ownedMessage = await seedMessage(owned, account.id);
    const keyA = mediaKey();
    const keyB = mediaKey();
    await seedMediaItem(ownedMessage, keyA);
    await seedMediaItem(ownedMessage, keyB);
    const { paymentId, usageId, walletId } = await seedFinancialRows(account.id);
    const args = executorArgs(account.id);

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });

    // The users row and the owned conversation graph are gone.
    expect(await db.select().from(users).where(eq(users.id, account.id))).toHaveLength(0);
    expect(await db.select().from(conversations).where(eq(conversations.id, owned))).toHaveLength(
      0
    );
    expect(await db.select().from(messages).where(eq(messages.id, ownedMessage))).toHaveLength(0);

    // The foreign conversation's message survives, sender detached.
    const [survivor] = await db
      .select({ senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, foreignMessage));
    expect(survivor).toEqual({ senderId: null });

    // Memberships carry leftAt with userId nulled by the FK.
    const memberRows = await db
      .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, foreign));
    expect(memberRows.some((row) => row.userId === null && row.leftAt !== null)).toBe(true);

    // Financial rows survive pseudonymized: present, userId severed.
    const [walletRow] = await db
      .select({ userId: wallets.userId })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    expect(walletRow).toEqual({ userId: null });
    const [paymentRow] = await db
      .select({ userId: payments.userId })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(paymentRow).toEqual({ userId: null });
    const [usageRow] = await db
      .select({ payerUserId: usageRecords.payerUserId })
      .from(usageRecords)
      .where(eq(usageRecords.id, usageId));
    expect(usageRow).toEqual({ payerUserId: null });

    // The anonymous forensic event exists.
    const events = await db
      .select({ ipAddress: accountDeletionEvents.ipAddress })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, args.userAgent));
    expect(events).toEqual([{ ipAddress: '203.0.113.7' }]);

    // The reclaim job carries exactly the owned storage keys, on the bulk shard.
    const jobRows = await db
      .select({ shard: jobs.shard, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.id}`
        )
      );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.shard).toBe('bulk');
    const payload = jobRows[0]?.payload as { storageKeys: string[] };
    expect([...payload.storageKeys].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [keyA, keyB].toSorted((a, b) => a.localeCompare(b))
    );

    // Post-commit: watermark written, rooms evicted, notification sent.
    const watermark = await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(account.id));
    expect(Number(watermark)).toBe(args.now.getTime());
    expect(evicted).toContain(account.id);
    expect(sentDeleted).toContain(account.email);

    // Scoped cleanup: the pseudonymized wallet row has no user to cascade from.
    await db.delete(wallets).where(eq(wallets.id, walletId));
  });

  it("erases the content of the account's messages in conversations it does not own", async () => {
    const account = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other.id);
    const owned = await seedConversation(account.id);
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, userId: account.id, visibleFromEpoch: 1 });
    const foreignMessage = await seedMessage(foreign, account.id);
    const foreignKey = mediaKey();
    await seedTextItem(foreignMessage);
    await seedMediaItem(foreignMessage, foreignKey);
    const assistantReply = await seedMessage(foreign, ASSISTANT_SENDER_ID, 'assistant');
    await seedTextItem(assistantReply);
    const ownerMessage = await seedMessage(foreign, other.id);
    await seedTextItem(ownerMessage);
    const ownedMessage = await seedMessage(owned, account.id);
    const ownedKey = mediaKey();
    await seedMediaItem(ownedMessage, ownedKey);
    const args = executorArgs(account.id);

    const outcome = await executeAccountDeletion(args);

    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(await messageState(foreignMessage)).toEqual({
      senderId: null,
      deletedAt: args.now,
      contentItemCount: 0,
    });
    expect(await messageState(assistantReply)).toEqual({
      senderId: ASSISTANT_SENDER_ID,
      deletedAt: null,
      contentItemCount: 1,
    });
    expect(await messageState(ownerMessage)).toEqual({
      senderId: other.id,
      deletedAt: null,
      contentItemCount: 1,
    });
    const jobRows = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.id}`
        )
      );
    expect(jobRows).toHaveLength(1);
    const payload = jobRows[0]?.payload as { storageKeys: string[] };
    expect([...payload.storageKeys].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [ownedKey, foreignKey].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('reclaims the media of an account whose only stored media sits in a foreign conversation', async () => {
    const account = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other.id);
    const foreignMessage = await seedMessage(foreign, account.id);
    const foreignKey = mediaKey();
    await seedMediaItem(foreignMessage, foreignKey);

    const outcome = await executeAccountDeletion(executorArgs(account.id));

    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    const jobRows = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.id}`
        )
      );
    expect(jobRows.map((row) => (row.payload as { storageKeys: string[] }).storageKeys)).toEqual([
      [foreignKey],
    ]);
  });

  it("revokes the links the account minted in someone else's conversation", async () => {
    const account = await seedUser();
    const host = await seedUser();
    const foreign = await seedConversation(host.id);
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, userId: account.id, visibleFromEpoch: 1 });
    const { linkPublicKey, linkAuthHash } = mintLinkCredential();
    const [link] = await db
      .insert(sharedLinks)
      .values({ conversationId: foreign, createdBy: account.id, linkPublicKey, linkAuthHash })
      .returning({ id: sharedLinks.id });
    const linkId = link?.id ?? '';
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, linkId, visibleFromEpoch: 1 });

    const outcome = await executeAccountDeletion(executorArgs(account.id));

    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    const [row] = await db
      .select({ createdBy: sharedLinks.createdBy, revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row?.createdBy).toBeNull();
    expect(row?.revokedAt).not.toBeNull();
  });

  it('leaves the guest seat of a revoked link departed rather than active', async () => {
    const account = await seedUser();
    const host = await seedUser();
    const foreign = await seedConversation(host.id);
    const { linkPublicKey, linkAuthHash } = mintLinkCredential();
    const [link] = await db
      .insert(sharedLinks)
      .values({ conversationId: foreign, createdBy: account.id, linkPublicKey, linkAuthHash })
      .returning({ id: sharedLinks.id });
    const linkId = link?.id ?? '';
    const [guest] = await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, linkId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });

    const outcome = await executeAccountDeletion(executorArgs(account.id));

    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    const [row] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, guest?.id ?? ''));
    expect(row?.leftAt).not.toBeNull();
  });

  it('enqueues no reclaim job for an account without stored media', async () => {
    const account = await seedUser();
    await seedConversation(account.id);

    const outcome = await executeAccountDeletion(executorArgs(account.id));
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });

    const jobRows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.id}`
        )
      );
    expect(jobRows).toHaveLength(0);
  });

  it('answers not-found for a user that no longer exists, writing nothing', async () => {
    const ghost = crypto.randomUUID();
    const args = executorArgs(ghost);

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'not-found' });

    const events = await db
      .select({ id: accountDeletionEvents.id })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, args.userAgent));
    expect(events).toHaveLength(0);
    expect(await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(ghost))).toBeNull();
  });

  it('leaves NOTHING changed when a step inside the transaction fails', async () => {
    const account = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other.id);
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, userId: account.id, visibleFromEpoch: 1 });
    const foreignMessage = await seedMessage(foreign, account.id);
    await seedTextItem(foreignMessage);
    await seedMediaItem(foreignMessage, mediaKey());
    const args = executorArgs(account.id, {
      detachMessageSendersWithinTx: () => {
        throw new Error('injected failure before the users delete');
      },
    });

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');

    // Atomicity: the user survives, membership still active, sender intact,
    // no event row, no job row, no revocation side effects.
    expect(await db.select().from(users).where(eq(users.id, account.id))).toHaveLength(1);
    const [member] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, foreign),
          eq(conversationMembers.userId, account.id)
        )
      );
    expect(member?.leftAt).toBeNull();
    expect(await messageState(foreignMessage)).toEqual({
      senderId: account.id,
      deletedAt: null,
      contentItemCount: 2,
    });
    expect(
      await db
        .select({ id: accountDeletionEvents.id })
        .from(accountDeletionEvents)
        .where(eq(accountDeletionEvents.userAgent, args.userAgent))
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
            sql`${jobs.payload} ->> 'userId' = ${account.id}`
          )
        )
    ).toHaveLength(0);
    expect(await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(account.id))).toBeNull();
  });

  // The mailing list is consent given to the list, not data held on behalf of
  // the account, so hard deletion severs the user link and leaves the row —
  // address and consent evidence included. Unsubscribing is what ends it.
  it('leaves the newsletter subscription and its consent evidence intact', async () => {
    const account = await seedUser();
    const subscription = await seedSubscription(account.id);

    const outcome = await executeAccountDeletion(executorArgs(account.id));
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });

    const [row] = await db
      .select({
        userId: newsletterSubscribers.userId,
        email: newsletterSubscribers.email,
        consentIp: newsletterSubscribers.consentIp,
        consentTextVersion: newsletterSubscribers.consentTextVersion,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.id, subscription.id));
    expect(row).toEqual({
      userId: null,
      email: subscription.email,
      consentIp: CONSENT_IP,
      consentTextVersion: CONSENT_TEXT_VERSION,
    });
  });

  // The owned-conversation cascade grows with the account, so a request-path
  // statement bound would cancel a large enough deletion on every attempt.
  it('lifts the statement bound before any other step of its transaction', async () => {
    const account = await seedUser();
    const calls: string[] = [];
    function recorded<A extends unknown[], R>(
      name: string,
      step: (...args: A) => R
    ): (...args: A) => R {
      return (...args) => {
        calls.push(name);
        return step(...args);
      };
    }
    const real = stores.users;
    const store: IdentityUsersStore = {
      ...real,
      liftStatementTimeoutWithinTx: recorded(
        'liftStatementTimeoutWithinTx',
        real.liftStatementTimeoutWithinTx
      ),
      lockForDeletionWithinTx: recorded('lockForDeletionWithinTx', real.lockForDeletionWithinTx),
      insertDeletionEventWithinTx: recorded(
        'insertDeletionEventWithinTx',
        real.insertDeletionEventWithinTx
      ),
      deleteUserWithinTx: recorded('deleteUserWithinTx', real.deleteUserWithinTx),
    };
    const args = {
      ...executorArgs(account.id, {
        captureContentStorageKeysWithinTx: recorded(
          'captureContentStorageKeysWithinTx',
          captureContentStorageKeysWithinTx
        ),
        detachMessageSendersWithinTx: recorded(
          'detachMessageSendersWithinTx',
          detachMessageSendersWithinTx
        ),
      }),
      store,
    };

    const outcome = await executeAccountDeletion(args);

    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(calls[0]).toBe('liftStatementTimeoutWithinTx');
  });

  it('still reports deleted when the notification send fails (best-effort tail)', async () => {
    const account = await seedUser();
    const args = {
      ...executorArgs(account.id),
      accountDeletedEmail: {
        sendAccountDeletedEmail: () => errAsync(unavailableError('email sender down')),
      },
      evictUser: undefined,
    };

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(await db.select().from(users).where(eq(users.id, account.id))).toHaveLength(0);
  });
});
