import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  messages,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { ASSISTANT_SENDER_ID } from '../domain/settlement/settlement.js';
import {
  captureContentStorageKeysWithinTx,
  deleteForeignMessageContentWithinTx,
  detachMessageSendersWithinTx,
} from './account-deletion.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat account-deletion tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, so the next file to land on that slot sees whatever rows this one
 * leaves behind.
 */
const PREFIX = `zh${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

async function seedUser(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${PREFIX}u${String(counter)}@chat-deletion.test`,
        username: `${PREFIX}u${String(counter)}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  if (!row) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row.id;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: ownerUserId,
    title: BYTES,
  });
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

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('captureContentStorageKeysWithinTx', () => {
  it('captures the distinct non-null storage keys of exactly the given conversations', async () => {
    const owner = await seedUser();
    const owned = await seedConversation(owner);
    const foreign = await seedConversation(owner);
    const ownedMessage = await seedMessage(owned, owner);
    const foreignMessage = await seedMessage(foreign, owner);
    const keyA = mediaKey();
    const keyB = mediaKey();
    const foreignKey = mediaKey();
    await seedMediaItem(ownedMessage, keyA);
    await seedMediaItem(ownedMessage, keyB);
    await seedTextItem(ownedMessage);
    await seedMediaItem(foreignMessage, foreignKey);

    const keys = await runSettlement(db, (tx) => captureContentStorageKeysWithinTx(tx, [owned]));

    expect([...keys].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [keyA, keyB].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('answers an empty conversation list with no keys and no query', async () => {
    const keys = await runSettlement(db, (tx) => captureContentStorageKeysWithinTx(tx, []));
    expect(keys).toEqual([]);
  });
});

describe('detachMessageSendersWithinTx', () => {
  it("nulls the user's senderId outside the excluded conversations and nowhere else", async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const ownedByLeaver = await seedConversation(leaver);
    const foreign = await seedConversation(other);
    const keepSender = await seedMessage(ownedByLeaver, leaver);
    const detach = await seedMessage(foreign, leaver);
    const untouched = await seedMessage(foreign, other);

    await runSettlement(db, (tx) => detachMessageSendersWithinTx(tx, leaver, [ownedByLeaver]));

    const rows = await db
      .select({ id: messages.id, senderId: messages.senderId })
      .from(messages)
      .where(inArray(messages.id, [keepSender, detach, untouched]));
    const byId = new Map(rows.map((row) => [row.id, row.senderId]));
    expect(byId.get(keepSender)).toBe(leaver);
    expect(byId.get(detach)).toBeNull();
    expect(byId.get(untouched)).toBe(other);
  });

  it('detaches every message of a user who owns no conversations', async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other);
    const detach = await seedMessage(foreign, leaver);

    await runSettlement(db, (tx) => detachMessageSendersWithinTx(tx, leaver, []));

    const [row] = await db
      .select({ senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, detach));
    expect(row?.senderId).toBeNull();
  });
});

describe('deleteForeignMessageContentWithinTx', () => {
  const DELETED_AT = new Date(TEST_DAY_START);

  async function contentItemCount(messageId: string): Promise<number> {
    const rows = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(eq(contentItems.messageId, messageId));
    return rows.length;
  }

  async function deletedAtOf(messageId: string): Promise<Date | null | undefined> {
    const [row] = await db
      .select({ deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, messageId));
    return row?.deletedAt;
  }

  it('returns the storage keys of the content items it deleted', async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(leaver);
    const foreign = await seedConversation(other);
    const foreignMessage = await seedMessage(foreign, leaver);
    const ownedMessage = await seedMessage(owned, leaver);
    const keyA = mediaKey();
    const keyB = mediaKey();
    await seedMediaItem(foreignMessage, keyA);
    await seedMediaItem(foreignMessage, keyB);
    await seedTextItem(foreignMessage);
    await seedMediaItem(ownedMessage, mediaKey());

    const keys = await runSettlement(db, (tx) =>
      deleteForeignMessageContentWithinTx(tx, leaver, [owned], DELETED_AT)
    );

    expect([...keys].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [keyA, keyB].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it("deletes every content item of the user's messages outside the owned conversations", async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other);
    const foreignMessage = await seedMessage(foreign, leaver);
    await seedMediaItem(foreignMessage, mediaKey());
    await seedTextItem(foreignMessage);

    await runSettlement(db, (tx) =>
      deleteForeignMessageContentWithinTx(tx, leaver, [], DELETED_AT)
    );

    expect(await contentItemCount(foreignMessage)).toBe(0);
  });

  it('stamps deletedAt on the selected messages and keeps their rows', async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other);
    const foreignMessage = await seedMessage(foreign, leaver);
    await seedTextItem(foreignMessage);

    await runSettlement(db, (tx) =>
      deleteForeignMessageContentWithinTx(tx, leaver, [], DELETED_AT)
    );

    expect(await deletedAtOf(foreignMessage)).toEqual(DELETED_AT);
  });

  it('leaves messages outside the selection untouched', async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(leaver);
    const foreign = await seedConversation(other);
    const ownedMessage = await seedMessage(owned, leaver);
    const othersMessage = await seedMessage(foreign, other);
    const assistantReply = await seedMessage(foreign, ASSISTANT_SENDER_ID, 'assistant');
    for (const id of [ownedMessage, othersMessage, assistantReply]) {
      await seedTextItem(id);
      await seedMediaItem(id, mediaKey());
    }

    const keys = await runSettlement(db, (tx) =>
      deleteForeignMessageContentWithinTx(tx, leaver, [owned], DELETED_AT)
    );

    expect(keys).toEqual([]);
    for (const id of [ownedMessage, othersMessage, assistantReply]) {
      expect(await contentItemCount(id)).toBe(2);
      expect(await deletedAtOf(id)).toBeNull();
    }
  });
});
