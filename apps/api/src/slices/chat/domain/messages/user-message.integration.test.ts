import { afterAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  decryptContentEnvelope,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationForks,
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ERROR_CODES } from '@hushbox/shared';
import {
  createConversationsStores,
  reserveSequenceBlockWithinTx,
} from '../../../conversations/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { createChatStores } from '../../adapters/stores.js';
import { broadcastUserMessageNew, saveUserOnlyMessage } from './user-message.js';
import {
  seatCurrentEpochHolder,
  seedConversationWithEpoch,
} from '../../../../test-support/conversation-seed.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type { RealtimeEvent } from '@hushbox/realtime';
import type { RealtimeBroadcast } from '../../../conversations/index.js';
import type { EpochPublicKeyReader } from '../settlement/settlement.js';
import type { SaveUserOnlyMessageDeps } from './user-message.js';

/**
 * The runless Pattern-A user-only send: one transaction resolves the parent
 * tip, reserves one sequence, wraps the content to the CURRENT epoch through
 * the shared insert primitive, and inserts the message + text content item
 * under an id the save mints itself.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat user-message integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([7, 7, 7]);
const decoder = new TextDecoder();
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

interface Fixture {
  readonly userId: string;
  readonly conversationId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@user-msg.test`,
        username: `um${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = first(userRows, 'user').id;
  createdUserIds.push(userId);
  return userId;
}

async function seedFixture(): Promise<Fixture> {
  const userId = await seedUser();
  const keyPair = generateEpochKeyPair();
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: keyPair.publicKey,
  });
  createdConversationIds.push(conversationId);
  return { userId, conversationId, epochPrivateKey: keyPair.privateKey };
}

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

/** Everything a save needs but the transaction it runs in. */
type SaveDeps = Omit<SaveUserOnlyMessageDeps, 'tx'>;
type SaveArgs = Parameters<typeof saveUserOnlyMessage>[1];
type SaveResult = Awaited<ReturnType<typeof saveUserOnlyMessage>>;

function deps(overrides: Partial<SaveDeps> = {}): SaveDeps {
  return {
    stores: createChatStores(),
    readEpochPublicKey,
    newId: () => crypto.randomUUID(),
    ...overrides,
  };
}

/** Carries a refused save out of its transaction so the transaction rolls back. */
class SaveRefused extends Error {}

/**
 * Runs one save in a transaction of its own that rolls back when the save
 * refuses, as the route's key-row transaction does around it.
 */
async function save(saveDeps: SaveDeps, args: SaveArgs): Promise<SaveResult> {
  let result: SaveResult | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await saveUserOnlyMessage({ ...saveDeps, tx }, args);
      if (result.isErr()) throw new SaveRefused();
    });
  } catch (error) {
    if (!(error instanceof SaveRefused)) throw error;
  }
  if (result === undefined) throw new Error('the save never ran');
  return result;
}

/** How many messages a conversation holds. */
async function messageCount(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return rows.length;
}

async function seedFork(
  conversationId: string,
  tipMessageId: string | null,
  name = 'Branch'
): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name, tipMessageId })
    .returning({ id: conversationForks.id });
  const forkId = rows[0]?.id;
  if (forkId === undefined) throw new Error('fork seed failed');
  return forkId;
}

/**
 * Polls pg_stat_activity until `pid`'s backend is parked on a row-lock wait —
 * the state a statement enters when the row it needs is held by another open
 * transaction. Observing it proves the contender REACHED its statement and
 * blocked, rather than inferring serialization from the outcome. Returns false
 * on the budget so a contender that never blocks fails an assertion instead of
 * wedging the test.
 */
async function backendBlocksOnLock(
  probe: ReturnType<typeof createDb>,
  pid: number
): Promise<boolean> {
  const deadlineMs = Date.now() + 4000;
  for (;;) {
    const result = await probe.execute(
      sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`
    );
    const rows = result.rows as { wait_event_type: string | null }[];
    if (rows.some((row) => row.wait_event_type === 'Lock')) return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function forkTip(forkId: string): Promise<string | null> {
  const rows = await db
    .select({ tip: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));
  return rows[0]?.tip ?? null;
}

describe('saveUserOnlyMessage', () => {
  it('persists the message and its text content item at the reserved sequence', async () => {
    const fixture = await seedFixture();

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'hello without ai',
    });

    const outcome = result._unsafeUnwrap();
    expect(outcome).toEqual({
      messageId: expect.any(String),
      sequenceNumber: 1,
      epochNumber: 1,
    });
    const { messageId } = outcome;

    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    const message = first(messageRows, 'message');
    expect(message.senderType).toBe('user');
    expect(message.senderId).toBe(fixture.userId);
    expect(message.epochNumber).toBe(1);
    expect(message.sequenceNumber).toBe(1);
    expect(message.parentMessageId).toBeNull();
    expect(message.batchId).toBeTruthy();

    // The content decrypts with the epoch key under the shared primitive's AAD.
    const contentRows = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, messageId));
    const content = first(contentRows, 'content item');
    expect(content.modelId).toBeNull();
    expect(content.costNanoUsd).toBeNull();
    if (content.encryptedBlob === null) throw new Error('expected an encrypted blob');
    const wrapped = message.wrappedContentKey as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(fixture.epochPrivateKey, wrapped);
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: fixture.conversationId,
        messageId,
        contentItemId: content.id,
        position: 0,
        epochNumber: 1,
        senderId: fixture.userId,
      },
      content.encryptedBlob
    );
    expect(decoder.decode(plaintext)).toBe('hello without ai');
  });

  it('stores the message under the first id it mints', async () => {
    const fixture = await seedFixture();
    const minted = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    let next = 0;
    const newId = (): string => {
      const id = minted[next];
      next += 1;
      if (id === undefined) throw new Error('the save minted more ids than expected');
      return id;
    };

    const result = await save(deps({ newId }), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'whose id is this',
    });

    expect(result._unsafeUnwrap().messageId).toBe(minted[0]);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, minted[0] ?? ''));
    expect(rows).toHaveLength(1);
  });

  it('mints a distinct id for each save of the same content', async () => {
    const fixture = await seedFixture();
    const send = (): Promise<SaveResult> =>
      save(deps(), {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content: 'same message',
      });

    const firstSend = await send();
    const secondSend = await send();
    const firstId = firstSend._unsafeUnwrap().messageId;
    const secondId = secondSend._unsafeUnwrap().messageId;

    expect(secondId).not.toBe(firstId);
    expect(await messageCount(fixture.conversationId)).toBe(2);
  });

  it('chains onto the conversation tip (highest-sequence message)', async () => {
    const fixture = await seedFixture();

    const seeded = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'one',
    });
    const firstId = seeded._unsafeUnwrap().messageId;
    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'two',
    });

    const outcome = result._unsafeUnwrap();
    expect(outcome).toMatchObject({ sequenceNumber: 2 });
    const rows = await db.select().from(messages).where(eq(messages.id, outcome.messageId));
    expect(first(rows, 'message').parentMessageId).toBe(firstId);
  });

  it('parents a fork send onto the fork tip, not the linear tip, and advances that tip', async () => {
    const fixture = await seedFixture();
    // Two linear messages: the conversation's linear tip becomes the second.
    const seededFirst = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'one',
    });
    const firstId = seededFirst._unsafeUnwrap().messageId;
    const seededSecond = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'two',
    });
    expect(seededSecond.isOk()).toBe(true);
    // A branch whose tip is the first message (diverges from the linear tip).
    const forkId = await seedFork(fixture.conversationId, firstId);

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'on the branch',
      forkId,
    });

    const forkMessageId = result._unsafeUnwrap().messageId;
    const rows = await db.select().from(messages).where(eq(messages.id, forkMessageId));
    // Parents onto the FORK tip, NOT the linear tip: the tip→root fork walk
    // therefore still reaches it after a refetch.
    expect(first(rows, 'message').parentMessageId).toBe(firstId);
    // And the fork's own tip advances to the new message.
    expect(await forkTip(forkId)).toBe(forkMessageId);
  });

  it('chains onto a null-tipped fork (parent null) and advances the tip', async () => {
    const fixture = await seedFixture();
    const seeded = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'linear',
    });
    expect(seeded.isOk()).toBe(true);
    const forkId = await seedFork(fixture.conversationId, null, 'Empty branch');

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'root of branch',
      forkId,
    });

    const forkMessageId = result._unsafeUnwrap().messageId;
    const rows = await db.select().from(messages).where(eq(messages.id, forkMessageId));
    expect(first(rows, 'message').parentMessageId).toBeNull();
    expect(await forkTip(forkId)).toBe(forkMessageId);
  });

  it('answers not_found for a forkId absent at persist', async () => {
    const fixture = await seedFixture();
    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'branch gone',
      forkId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    expect(await messageCount(fixture.conversationId)).toBe(0);
  });

  it('surfaces a conflict when the fork-tip CAS advances zero rows', async () => {
    const fixture = await seedFixture();
    const forkId = await seedFork(fixture.conversationId, null, 'Raced branch');
    const result = await save(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            forks: {
              ...real.forks,
              // The CAS finds zero rows (tip moved under us); the fork still
              // exists, so the re-read disambiguates to a conflict.
              updateTip: () => okAsync(null),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content: 'raced advance',
        forkId,
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
    // The whole transaction rolled back: no message persisted.
    expect(await messageCount(fixture.conversationId)).toBe(0);
  });

  it('fails unavailable when a writer that bypassed the counter holds the next sequence', async () => {
    const fixture = await seedFixture();
    const seeded = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'seed tip',
    });
    expect(seeded.isOk()).toBe(true);
    // A writer that bypassed the counter occupies the NEXT sequence slot (2):
    // the reservation then collides on the (conversation, sequence) unique
    // index, which only a counter defect can cause.
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: fixture.conversationId,
      senderType: 'user',
      senderId: fixture.userId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 2,
    });

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'collides',
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(await messageCount(fixture.conversationId)).toBe(2);
  });

  it('does not collide with a concurrently reserved settlement block', async () => {
    const fixture = await seedFixture();
    // A live run's settlement reserves its block first (user + two siblings).
    const block = await reserveSequenceBlockWithinTx(createConversationsStores(db), {
      conversationId: fixture.conversationId,
      count: 3,
    });
    expect(block._unsafeUnwrap()).toEqual([1, 2, 3]);

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'during a run',
    });
    // Disjoint blocks: the user-only send lands after the run's reservation,
    // never violating the (conversation, sequence) unique constraint.
    expect(result._unsafeUnwrap()).toMatchObject({ sequenceNumber: 4 });
  });

  it('wraps to the epoch a rotation left current', async () => {
    const fixture = await seedFixture();
    const rotatedKeyPair = generateEpochKeyPair();
    await db.insert(epochs).values({
      conversationId: fixture.conversationId,
      epochNumber: 2,
      epochPublicKey: rotatedKeyPair.publicKey,
      confirmationHash: BYTES,
    });
    await db
      .update(conversations)
      .set({ currentEpoch: 2 })
      .where(eq(conversations.id, fixture.conversationId));

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'after a rotation',
    });

    // Epoch-at-persist: the send wraps to the rotation-final epoch (2) — never
    // the superseded epoch a removed member's key material still opens.
    const outcome = result._unsafeUnwrap();
    expect(outcome).toEqual({
      messageId: expect.any(String),
      sequenceNumber: 1,
      epochNumber: 2,
    });
    const { messageId } = outcome;
    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    const message = first(messageRows, 'message');
    expect(message.epochNumber).toBe(2);
    // The wrap key matches too: the content decrypts with the ROTATED epoch key.
    const contentRows = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, messageId));
    const content = first(contentRows, 'content item');
    if (content.encryptedBlob === null) throw new Error('expected an encrypted blob');
    const wrapped = message.wrappedContentKey as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(rotatedKeyPair.privateKey, wrapped);
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: fixture.conversationId,
        messageId,
        contentItemId: content.id,
        position: 0,
        epochNumber: 2,
        senderId: fixture.userId,
      },
      content.encryptedBlob
    );
    expect(decoder.decode(plaintext)).toBe('after a rotation');
  });

  it('holds a rotation started mid-send behind its conversation lock', async () => {
    const fixture = await seedFixture();
    const rotatedKeyPair = generateEpochKeyPair();
    // Two extra connections: the rotation runs on one (the dev pool is max 1, so
    // a shared handle would queue at the pool instead of at the row lock), and
    // the block is observed from a third that must stay free while the send's
    // transaction holds the second.
    const rotationDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const probeDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

    let startRotation!: () => void;
    const sendHoldsTheLock = new Promise<void>((resolve) => {
      startRotation = resolve;
    });
    let publishRotationPid!: (pid: number) => void;
    const rotationPid = new Promise<number>((resolve) => {
      publishRotationPid = resolve;
    });

    // The rotation's transaction is opened and its backend published BEFORE the
    // send runs, so what the probe below observes is a backend that reached its
    // statement and parked — never one still connecting.
    const rotation = rotationDb.transaction(async (tx) => {
      const pidRows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      const pidRow = pidRows.rows[0] as { pid: number } | undefined;
      if (pidRow === undefined) throw new Error('failed to read the rotation backend pid');
      publishRotationPid(pidRow.pid);
      await sendHoldsTheLock;
      // Both statements need the conversation row — the epochs insert takes the
      // FK's key-share lock, the UPDATE an exclusive one — so both conflict with
      // the send's `FOR UPDATE` and neither can land until it commits.
      await tx.insert(epochs).values({
        conversationId: fixture.conversationId,
        epochNumber: 2,
        epochPublicKey: rotatedKeyPair.publicKey,
        confirmationHash: BYTES,
      });
      await tx
        .update(conversations)
        .set({ currentEpoch: 2 })
        .where(eq(conversations.id, fixture.conversationId));
    });

    try {
      // The teeth: the serialization is READ OFF POSTGRES while the send is still
      // open, not inferred from the outcome. Drop the send's conversation lock and
      // the rotation runs to completion unobstructed, so this stays false.
      let rotationBlocked = false;
      const result = await save(
        deps({
          conversationsStores: (tx) => {
            const real = createConversationsStores(tx);
            return {
              ...real,
              conversations: {
                ...real.conversations,
                lockForUpdate: (conversationId) =>
                  real.conversations.lockForUpdate(conversationId).map(async (row) => {
                    startRotation();
                    rotationBlocked = await backendBlocksOnLock(probeDb, await rotationPid);
                    return row;
                  }),
              },
            };
          },
        }),
        {
          conversationId: fixture.conversationId,
          senderId: fixture.userId,
          content: 'sent under the lock',
        }
      );

      expect(rotationBlocked).toBe(true);
      // Blocked for the whole transaction, so the rotation could not interleave
      // between the locked epoch read and the persist: the send wrapped to the
      // epoch current under its own lock.
      expect(result._unsafeUnwrap()).toEqual({
        messageId: expect.any(String),
        sequenceNumber: 1,
        epochNumber: 1,
      });
      // Released by the commit, the rotation then lands.
      await rotation;
      const rows = await db
        .select({ currentEpoch: conversations.currentEpoch })
        .from(conversations)
        .where(eq(conversations.id, fixture.conversationId));
      expect(rows[0]?.currentEpoch).toBe(2);
    } finally {
      // Both pooled clients close whatever the assertions do: a pg pool left open
      // outlives the test and keeps its vitest worker from exiting. Releasing the
      // gate first bounds the await — a failure before the send takes its lock
      // would otherwise leave the rotation parked on it with nothing to release it.
      startRotation();
      await rotation.catch(() => undefined);
      await rotationDb.$client.end();
      await probeDb.$client.end();
    }
  });

  it('answers not_found for a missing conversation', async () => {
    const result = await save(deps(), {
      conversationId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      content: 'nowhere',
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('fails unavailable when the epoch wrap key is missing (defect guard)', async () => {
    const fixture = await seedFixture();
    const result = await save(deps({ readEpochPublicKey: () => Promise.resolve(null) }), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'no wrap key',
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('answers not_found when the locked conversation row is absent', async () => {
    const fixture = await seedFixture();
    const result = await save(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              lockForUpdate: () => okAsync(null),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content: 'row vanished',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    expect(await messageCount(fixture.conversationId)).toBe(0);
  });

  it('propagates a conversation-read failure as the store error', async () => {
    const fixture = await seedFixture();
    const result = await save(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              lockForUpdate: () => errAsync(unavailableError('conversations down')),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content: 'store failure',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('propagates a sequence-reservation failure and persists nothing', async () => {
    const fixture = await seedFixture();
    const result = await save(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              reserveSequenceBlock: () => errAsync(unavailableError('counter down')),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content: 'reservation failure',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(await messageCount(fixture.conversationId)).toBe(0);
  });

  it('refuses with ROTATION_PENDING and persists nothing while a departed key holds the current epoch', async () => {
    const fixture = await seedFixture();
    await seatCurrentEpochHolder(db, {
      conversationId: fixture.conversationId,
      userId: await seedUser(),
      departed: true,
    });

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'into a pending epoch',
    });

    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: 'conflict',
      wireCode: ERROR_CODES.ROTATION_PENDING,
    });
    expect(await messageCount(fixture.conversationId)).toBe(0);
  });

  it('persists the send when every current-epoch wrap belongs to a live seat', async () => {
    const fixture = await seedFixture();
    await seatCurrentEpochHolder(db, {
      conversationId: fixture.conversationId,
      userId: await seedUser(),
    });

    const result = await save(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      content: 'into a settled epoch',
    });

    expect(result.isOk()).toBe(true);
    expect(await messageCount(fixture.conversationId)).toBe(1);
  });

  it('propagates a pending-departure read failure and persists nothing', async () => {
    const fixture = await seedFixture();
    const result = await save(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            epochs: {
              ...real.epochs,
              conversationsWithDepartedHolders: () => errAsync(unavailableError('epochs down')),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content: 'pending read failure',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(await messageCount(fixture.conversationId)).toBe(0);
  });

  it('keeps monotonic ordering across sends (never reuses a sequence)', async () => {
    const fixture = await seedFixture();
    for (const content of ['a', 'b', 'c']) {
      const result = await save(deps(), {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        content,
      });
      expect(result.isOk()).toBe(true);
    }
    const rows = await db
      .select({ sequenceNumber: messages.sequenceNumber })
      .from(messages)
      .where(eq(messages.conversationId, fixture.conversationId))
      .orderBy(asc(messages.sequenceNumber));
    expect(rows.map((row) => row.sequenceNumber)).toEqual([1, 2, 3]);
  });
});

describe('broadcastUserMessageNew', () => {
  function capturingRealtime(events: RealtimeEvent[]): RealtimeBroadcast {
    return {
      broadcast: (_conversationId, event) => {
        events.push(event);
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
      evict: () => okAsync(0),
      presence: () => okAsync([]),
      startRun: () => okAsync({ started: false, code: 'CONCURRENT_RUN' }),
      stopRun: () => okAsync(false),
      upgrade: () => okAsync(new Response(null, { status: 200 })),
    };
  }

  it('broadcasts message:new with the user sender and sequence', async () => {
    const events: RealtimeEvent[] = [];
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const senderId = crypto.randomUUID();

    const result = await broadcastUserMessageNew(capturingRealtime(events), {
      conversationId,
      messageId,
      senderId,
      sequenceNumber: 5,
    });

    expect(result.isOk()).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'message:new',
        conversationId,
        messageId,
        senderType: 'user',
        senderId,
        sequenceNumber: 5,
      }),
    ]);
  });

  it('surfaces a broadcast failure as the Result error (best-effort at the caller)', async () => {
    const failing: RealtimeBroadcast = {
      ...capturingRealtime([]),
      broadcast: () => errAsync(unavailableError('room unreachable')),
    };
    const result = await broadcastUserMessageNew(failing, {
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      sequenceNumber: 1,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
