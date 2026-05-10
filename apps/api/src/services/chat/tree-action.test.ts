import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  conversations,
  epochs,
  type Database,
} from '@hushbox/db';
import { userFactory, conversationFactory, messageFactory } from '@hushbox/db/factories';
import { applyTreeAction } from './tree-action.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

interface TestSetup {
  user: typeof users.$inferSelect;
  conversation: typeof conversations.$inferSelect;
}

async function createTestSetup(db: Database): Promise<TestSetup> {
  const userData = userFactory.build();
  const [createdUser] = await db.insert(users).values(userData).returning();
  if (!createdUser) throw new Error('Failed to create test user');

  const convData = conversationFactory.build({ userId: createdUser.id });
  const [createdConv] = await db.insert(conversations).values(convData).returning();
  if (!createdConv) throw new Error('Failed to create test conversation');

  await db.insert(epochs).values({
    conversationId: createdConv.id,
    epochNumber: 1,
    epochPublicKey: new Uint8Array(32),
    confirmationHash: new Uint8Array(32),
  });

  return { user: createdUser, conversation: createdConv };
}

async function insertMsg(
  db: Database,
  overrides: Partial<typeof messages.$inferSelect> & {
    conversationId: string;
    sequenceNumber: number;
  }
): Promise<typeof messages.$inferSelect> {
  const data = messageFactory.build({
    senderType: 'user',
    epochNumber: 1,
    ...overrides,
  });
  const [msg] = await db.insert(messages).values(data).returning();
  if (!msg) throw new Error('Failed to insert message');
  return msg;
}

describe('applyTreeAction', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      const convIds = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(inArray(conversations.userId, createdUserIds));
      const ids = convIds.map((c) => c.id);
      if (ids.length > 0) {
        await db.delete(messages).where(inArray(messages.conversationId, ids));
        await db.delete(epochs).where(inArray(epochs.conversationId, ids));
      }
      await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  describe('fresh-send', () => {
    it('returns the new user message as the assistant parent', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'fresh-send',
          userMessage: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'hi' },
          parentMessageId: null,
        })
      );

      expect(result.parentMessageIdForAssistants).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      expect(result.userMessageInsert).toEqual({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        content: 'hi',
        parentMessageId: null,
      });
      expect(result.forkTipExpectedMessageId).toBeNull();
    });

    it('forwards parentMessageId as the fork-tip guard when supplied', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const root = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'fresh-send',
          userMessage: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'next' },
          parentMessageId: root.id,
        })
      );

      expect(result.parentMessageIdForAssistants).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      expect(result.forkTipExpectedMessageId).toBe(root.id);
    });

    it('rejects null parent when conversation already has messages', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'fresh-send',
            userMessage: { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', content: 'no' },
            parentMessageId: null,
          })
        )
      ).rejects.toThrow();
    });

    it('rejects non-null parent that does not belong to the conversation', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'fresh-send',
            userMessage: { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', content: 'no' },
            parentMessageId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          })
        )
      ).rejects.toThrow();
    });

    it('does not delete or insert anything during the mutation step', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const root = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'fresh-send',
          userMessage: { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', content: 'next' },
          parentMessageId: root.id,
        })
      );

      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(root.id);
    });
  });

  describe('regenerate', () => {
    it('deletes messages after the anchor and preserves the anchor', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
        })
      );

      expect(result.parentMessageIdForAssistants).toBe(userMsg.id);
      expect(result.userMessageInsert).toBeUndefined();
      expect(result.forkTipExpectedMessageId).toBeNull();

      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      const ids = remaining.map((m) => m.id);
      expect(ids).toContain(userMsg.id);
      expect(ids).not.toContain(aiMsg.id);
    });

    it('forwards forkTipMessageId for fork-aware deletion and as fork-tip guard', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
          forkTipMessageId: aiMsg.id,
        })
      );

      expect(result.forkTipExpectedMessageId).toBe(aiMsg.id);

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(userMsg.id);
      expect(ids).not.toContain(aiMsg.id);
    });

    it('is a no-op when the anchor has no descendants', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
        })
      );

      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(userMsg.id);
    });
  });

  describe('edit', () => {
    it('replaces a non-root user message: deletes target+descendants, returns new user insert', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userA = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiA = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userA.id,
      });
      const userB = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        senderId: setup.user.id,
        parentMessageId: aiA.id,
      });
      const aiB = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 4,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userB.id,
      });

      const newUserId = '11111111-1111-1111-1111-111111111111';

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'edit',
          anchorUserMessageId: userB.id,
          newUserMessage: { id: newUserId, content: 'edited' },
        })
      );

      expect(result.parentMessageIdForAssistants).toBe(newUserId);
      expect(result.userMessageInsert).toEqual({
        id: newUserId,
        content: 'edited',
        parentMessageId: aiA.id,
      });
      expect(result.forkTipExpectedMessageId).toBeNull();

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(userA.id);
      expect(ids).toContain(aiA.id);
      expect(ids).not.toContain(userB.id);
      expect(ids).not.toContain(aiB.id);
    });

    it('replaces a root user message: deletes target+descendants, returns null parent', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const root = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const child = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: root.id,
      });

      const newUserId = '22222222-2222-2222-2222-222222222222';

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'edit',
          anchorUserMessageId: root.id,
          newUserMessage: { id: newUserId, content: 'edited root' },
        })
      );

      expect(result.parentMessageIdForAssistants).toBe(newUserId);
      expect(result.userMessageInsert).toEqual({
        id: newUserId,
        content: 'edited root',
        parentMessageId: null,
      });

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining.map((r) => r.id)).not.toContain(root.id);
      expect(remaining.map((r) => r.id)).not.toContain(child.id);
    });

    it('throws when the target message does not exist', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'edit',
            anchorUserMessageId: '99999999-9999-9999-9999-999999999999',
            newUserMessage: {
              id: '33333333-3333-3333-3333-333333333333',
              content: 'edited',
            },
          })
        )
      ).rejects.toThrow('Target message not found');
    });

    it('forwards forkTipMessageId as the fork-tip guard', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'edit',
          anchorUserMessageId: userMsg.id,
          newUserMessage: {
            id: '44444444-4444-4444-4444-444444444444',
            content: 'edited',
          },
          forkTipMessageId: aiMsg.id,
        })
      );

      expect(result.forkTipExpectedMessageId).toBe(aiMsg.id);
    });
  });
});
