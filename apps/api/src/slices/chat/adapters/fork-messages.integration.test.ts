import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, messages, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { deleteForkMessagesWithinTx } from './fork-messages.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';

/**
 * `deleteForkMessagesWithinTx` is the only cross-slice deleter of `messages`.
 * Its `conversationId` scope is defense-in-depth: the correct caller sources
 * ids from the same conversation, but a misusing caller passing a foreign id
 * must never delete outside the named conversation — the WHERE predicate is the
 * boundary, proven here against real Postgres.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for fork-message delete scope tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([7, 7, 7]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedConversationWithMessage(userId: string): Promise<{
  readonly conversationId: string;
  readonly messageId: string;
}> {
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  createdConversationIds.push(conversationId);

  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  return { conversationId, messageId };
}

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@fork-msg.test`,
        username: `fm${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return userId;
}

async function messageExists(messageId: string): Promise<boolean> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId));
  return rows.length > 0;
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('deleteForkMessagesWithinTx conversation scope', () => {
  it('never deletes a message belonging to a different conversation', async () => {
    const userId = await seedUser();
    const convA = await seedConversationWithMessage(userId);
    const convB = await seedConversationWithMessage(userId);

    // A misusing caller hands conversation A's id but conversation B's message.
    const result = await deleteForkMessagesWithinTx(db, convA.conversationId, [convB.messageId]);

    expect(result.isOk()).toBe(true);
    // The foreign message survives — the scope predicate refused it.
    expect(await messageExists(convB.messageId)).toBe(true);
    expect(await messageExists(convA.messageId)).toBe(true);
  });

  it('deletes ids that do belong to the named conversation (correct caller unchanged)', async () => {
    const userId = await seedUser();
    const conv = await seedConversationWithMessage(userId);

    const result = await deleteForkMessagesWithinTx(db, conv.conversationId, [conv.messageId]);

    expect(result.isOk()).toBe(true);
    expect(await messageExists(conv.messageId)).toBe(false);
  });
});
