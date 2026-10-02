import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createConversationsStores } from '../../adapters/stores.js';
import { getKeyChainBatch } from './keychain.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for batch keychain tests');
}

const BYTES = new Uint8Array([1, 2, 3]);

/**
 * Every statement the pool serves, recorded by wrapping the physical client's
 * `query` the moment the pool opens it. The count is the whole point of this
 * file: the Neon driver runs on a single-connection pool, so a per-id loop
 * shows up here as a statement count that climbs with the id set.
 */
const statements: string[] = [];
const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
interface CountedClient {
  query: (...args: unknown[]) => unknown;
}
db.$client.on('connect', (client: CountedClient) => {
  const original = client.query.bind(client);
  client.query = (...args: unknown[]): unknown => {
    const first = args[0];
    statements.push(typeof first === 'string' ? first : JSON.stringify(first));
    return original(...args);
  };
});
const stores = createConversationsStores(db);

/** The query schema's ceiling — the largest batch a client may ask for. */
const BATCH_CEILING = 100;

let callerUserId = '';
let callerPublicKey = new Uint8Array(32);
let batchIds: string[] = [];
let rotatedId = '';

async function seedMemberOfManyConversations(): Promise<void> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  callerPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@keychain-batch.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: callerPublicKey,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  callerUserId = userRows[0]?.id ?? '';

  // Conversations and their epoch 1 commit together: `current_epoch` is a
  // deferred foreign key into `epochs`, so neither half stands alone.
  const epochRows = await db.transaction(async (tx) => {
    const conversationRows = await tx
      .insert(conversations)
      .values(Array.from({ length: BATCH_CEILING }, () => ({ userId: callerUserId, title: BYTES })))
      .returning({ id: conversations.id });
    batchIds = conversationRows.map((row) => row.id);
    return tx
      .insert(epochs)
      .values(
        batchIds.map((conversationId) => ({
          conversationId,
          epochNumber: 1,
          epochPublicKey: BYTES,
          confirmationHash: BYTES,
          chainLink: null,
        }))
      )
      .returning({ id: epochs.id });
  });

  await db.insert(conversationMembers).values(
    batchIds.map((conversationId) => ({
      conversationId,
      userId: callerUserId,
      privilege: 'owner' as const,
      visibleFromEpoch: 1,
    }))
  );

  await db.insert(epochMembers).values(
    epochRows.map((row) => ({
      epochId: row.id,
      memberPublicKey: callerPublicKey,
      wrap: BYTES,
      visibleFromEpoch: 1,
    }))
  );
}

/** A conversation rotated nine times, whose member was seated at the eighth. */
async function seedRotatedConversation(): Promise<void> {
  // The rotated chain carries per-epoch confirmation hashes and chain links, so
  // it is written here rather than through the shared seed — but it still shares
  // the transaction with the conversation row that names its tenth epoch.
  const epochRows = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(conversations)
      .values({ userId: callerUserId, title: BYTES, currentEpoch: 10 })
      .returning({ id: conversations.id });
    rotatedId = rows[0]?.id ?? '';
    return tx
      .insert(epochs)
      .values(
        Array.from({ length: 10 }, (_unused, index) => ({
          conversationId: rotatedId,
          epochNumber: index + 1,
          epochPublicKey: BYTES,
          confirmationHash: new Uint8Array([index + 1]),
          chainLink: index === 0 ? null : new Uint8Array([100 + index]),
        }))
      )
      .returning({ id: epochs.id, epochNumber: epochs.epochNumber });
  });
  await db.insert(conversationMembers).values({
    conversationId: rotatedId,
    userId: callerUserId,
    privilege: 'write',
    visibleFromEpoch: 8,
  });
  await db.insert(epochMembers).values(
    epochRows
      .filter((row) => row.epochNumber >= 8)
      .map((row) => ({
        epochId: row.id,
        memberPublicKey: callerPublicKey,
        wrap: BYTES,
        visibleFromEpoch: 8,
      }))
  );
}

beforeAll(async () => {
  await seedMemberOfManyConversations();
  await seedRotatedConversation();
});

afterAll(async () => {
  const seeded = [...batchIds, rotatedId].filter((id) => id !== '');
  if (seeded.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, seeded));
  }
  if (callerUserId !== '') {
    await db.delete(users).where(inArray(users.id, [callerUserId]));
  }
  await db.$client.end();
});

describe('batch keychain query shape', () => {
  it('issues as many statements for the largest batch as for a single id', async () => {
    statements.length = 0;
    const single = await getKeyChainBatch(stores, {
      conversationIds: batchIds.slice(0, 1),
      callerUserId,
    });
    expect(Object.keys(single._unsafeUnwrap().keys)).toHaveLength(1);
    const forOne = statements.length;

    statements.length = 0;
    const whole = await getKeyChainBatch(stores, { conversationIds: batchIds, callerUserId });
    expect(Object.keys(whole._unsafeUnwrap().keys)).toHaveLength(BATCH_CEILING);

    expect(statements).toHaveLength(forOne);
  });

  it('issues one statement per read rather than one per conversation', async () => {
    statements.length = 0;
    const batched = await getKeyChainBatch(stores, { conversationIds: batchIds, callerUserId });
    expect(batched.isOk()).toBe(true);
    // The caller row, the conversation rows, the membership gate, the wraps,
    // the epoch records and the pending read — six reads, whatever the id count.
    expect(statements).toHaveLength(6);
  });

  it('answers a rotated conversation without reading any epoch below the member floor', async () => {
    const result = await getKeyChainBatch(stores, {
      conversationIds: [rotatedId],
      callerUserId,
    });

    const view = result._unsafeUnwrap().keys[rotatedId];
    expect(view?.wraps.map((wrap) => wrap.epochNumber)).toEqual([8, 9, 10]);
    expect(view?.epochs.map((epoch) => epoch.epochNumber)).toEqual([8, 9, 10]);
  });
});
