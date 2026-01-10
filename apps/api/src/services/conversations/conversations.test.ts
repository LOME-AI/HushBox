import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  messages,
  type Database,
} from '@lome-chat/db';
import { userFactory, conversationFactory, messageFactory } from '@lome-chat/db/factories';
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  createMessage,
} from './conversations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('conversations service', () => {
  let db: Database;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
      createdMessageIds.length = 0;
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
      createdConversationIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  async function createTestUser(): Promise<{ id: string }> {
    const userData = userFactory.build();
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return user;
  }

  async function createTestConversation(userId: string, title?: string): Promise<{ id: string }> {
    const convData = conversationFactory.build({ userId, ...(title !== undefined && { title }) });
    const [conv] = await db.insert(conversations).values(convData).returning();
    if (!conv) throw new Error('Failed to create test conversation');
    createdConversationIds.push(conv.id);
    return conv;
  }

  async function createTestMessage(
    conversationId: string,
    role: 'user' | 'assistant' = 'user'
  ): Promise<{ id: string }> {
    const msgData = messageFactory.build({ conversationId, role });
    const [msg] = await db.insert(messages).values(msgData).returning();
    if (!msg) throw new Error('Failed to create test message');
    createdMessageIds.push(msg.id);
    return msg;
  }

  describe('listConversations', () => {
    it('returns conversations for a user', async () => {
      const user = await createTestUser();
      await createTestConversation(user.id, 'Conv 1');
      await createTestConversation(user.id, 'Conv 2');

      const result = await listConversations(db, user.id);

      expect(result).toHaveLength(2);
    });

    it('returns empty array when user has no conversations', async () => {
      const user = await createTestUser();

      const result = await listConversations(db, user.id);

      expect(result).toEqual([]);
    });

    it('does not return conversations from other users', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      await createTestConversation(user1.id, 'User 1 Conv');
      await createTestConversation(user2.id, 'User 2 Conv');

      const result = await listConversations(db, user1.id);

      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('User 1 Conv');
    });

    it('returns conversations ordered by updatedAt descending', async () => {
      const user = await createTestUser();
      const conv1 = await createTestConversation(user.id, 'Older');
      const conv2 = await createTestConversation(user.id, 'Newer');

      // Update conv1 to be more recent
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(inArray(conversations.id, [conv1.id]));

      const result = await listConversations(db, user.id);

      expect(result[0]?.id).toBe(conv1.id);
      expect(result[1]?.id).toBe(conv2.id);
    });
  });

  describe('getConversation', () => {
    it('returns conversation with messages', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id, 'My Conv');
      await createTestMessage(conv.id, 'user');
      await createTestMessage(conv.id, 'assistant');

      const result = await getConversation(db, conv.id, user.id);

      expect(result).not.toBeNull();
      expect(result?.conversation.title).toBe('My Conv');
      expect(result?.messages).toHaveLength(2);
    });

    it('returns null for non-existent conversation', async () => {
      const user = await createTestUser();

      const result = await getConversation(db, 'non-existent-id', user.id);

      expect(result).toBeNull();
    });

    it('returns null when user does not own conversation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const conv = await createTestConversation(user1.id, 'User 1 Conv');

      const result = await getConversation(db, conv.id, user2.id);

      expect(result).toBeNull();
    });

    it('returns messages ordered by createdAt ascending', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);
      const msg1 = await createTestMessage(conv.id, 'user');
      const msg2 = await createTestMessage(conv.id, 'assistant');

      const result = await getConversation(db, conv.id, user.id);

      expect(result?.messages).toHaveLength(2);
      // Both messages should be returned
      const msgIds = result?.messages.map((m) => m.id) ?? [];
      expect(msgIds).toContain(msg1.id);
      expect(msgIds).toContain(msg2.id);
      // Messages should be in chronological order (first message created before second)
      const firstMsgTime = result?.messages[0]?.createdAt.getTime() ?? 0;
      const secondMsgTime = result?.messages[1]?.createdAt.getTime() ?? 0;
      expect(firstMsgTime).toBeLessThanOrEqual(secondMsgTime);
    });
  });

  describe('createConversation', () => {
    it('creates conversation with provided title', async () => {
      const user = await createTestUser();

      const result = await createConversation(db, user.id, { title: 'Custom Title' });
      createdConversationIds.push(result.conversation.id);

      expect(result.conversation.title).toBe('Custom Title');
      expect(result.conversation.userId).toBe(user.id);
      expect(result.message).toBeUndefined();
    });

    it('creates conversation with default title when none provided', async () => {
      const user = await createTestUser();

      const result = await createConversation(db, user.id, {});
      createdConversationIds.push(result.conversation.id);

      expect(result.conversation.title).toBe('New Conversation');
    });

    it('creates conversation with first message', async () => {
      const user = await createTestUser();

      const result = await createConversation(db, user.id, {
        firstMessage: { content: 'Hello world' },
      });
      createdConversationIds.push(result.conversation.id);
      if (result.message) createdMessageIds.push(result.message.id);

      expect(result.message).toBeDefined();
      expect(result.message?.content).toBe('Hello world');
      expect(result.message?.role).toBe('user');
    });

    it('uses first message content as title when no title provided', async () => {
      const user = await createTestUser();

      const result = await createConversation(db, user.id, {
        firstMessage: { content: 'This is a very long message that should be truncated' },
      });
      createdConversationIds.push(result.conversation.id);
      if (result.message) createdMessageIds.push(result.message.id);

      expect(result.conversation.title).toBe('This is a very long message that should be truncat');
    });
  });

  describe('updateConversation', () => {
    it('updates conversation title', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id, 'Old Title');

      const result = await updateConversation(db, conv.id, user.id, { title: 'New Title' });

      expect(result).not.toBeNull();
      expect(result?.title).toBe('New Title');
    });

    it('returns null for non-existent conversation', async () => {
      const user = await createTestUser();

      const result = await updateConversation(db, 'non-existent-id', user.id, { title: 'Title' });

      expect(result).toBeNull();
    });

    it('returns null when user does not own conversation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const conv = await createTestConversation(user1.id, 'User 1 Conv');

      const result = await updateConversation(db, conv.id, user2.id, { title: 'Hijacked' });

      expect(result).toBeNull();
    });

    it('updates updatedAt timestamp', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);

      const [original] = await db
        .select({ updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(inArray(conversations.id, [conv.id]));

      await new Promise((r) => setTimeout(r, 10)); // Small delay

      const result = await updateConversation(db, conv.id, user.id, { title: 'Updated' });

      if (!original) throw new Error('Original conversation not found');
      expect(result?.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
    });
  });

  describe('deleteConversation', () => {
    it('deletes conversation and returns true', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);

      const result = await deleteConversation(db, conv.id, user.id);

      expect(result).toBe(true);
      // Remove from cleanup since it's deleted
      createdConversationIds.splice(createdConversationIds.indexOf(conv.id), 1);
    });

    it('returns false for non-existent conversation', async () => {
      const user = await createTestUser();

      const result = await deleteConversation(db, 'non-existent-id', user.id);

      expect(result).toBe(false);
    });

    it('returns false when user does not own conversation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const conv = await createTestConversation(user1.id);

      const result = await deleteConversation(db, conv.id, user2.id);

      expect(result).toBe(false);
    });

    it('cascades delete to messages', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);
      const msg = await createTestMessage(conv.id);

      await deleteConversation(db, conv.id, user.id);

      const [remainingMsg] = await db
        .select()
        .from(messages)
        .where(inArray(messages.id, [msg.id]));
      expect(remainingMsg).toBeUndefined();

      // Remove from cleanup since they're deleted
      createdConversationIds.splice(createdConversationIds.indexOf(conv.id), 1);
      createdMessageIds.splice(createdMessageIds.indexOf(msg.id), 1);
    });
  });

  describe('createMessage', () => {
    it('creates message in conversation', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);

      const result = await createMessage(db, conv.id, user.id, {
        role: 'user',
        content: 'Hello!',
      });
      if (result) createdMessageIds.push(result.id);

      expect(result).not.toBeNull();
      expect(result?.role).toBe('user');
      expect(result?.content).toBe('Hello!');
      expect(result?.conversationId).toBe(conv.id);
    });

    it('creates message with model', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);

      const result = await createMessage(db, conv.id, user.id, {
        role: 'assistant',
        content: 'Hi there!',
        model: 'openai/gpt-4',
      });
      if (result) createdMessageIds.push(result.id);

      expect(result?.model).toBe('openai/gpt-4');
    });

    it('returns null when user does not own conversation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const conv = await createTestConversation(user1.id);

      const result = await createMessage(db, conv.id, user2.id, {
        role: 'user',
        content: 'Hijack attempt',
      });

      expect(result).toBeNull();
    });

    it('returns null for non-existent conversation', async () => {
      const user = await createTestUser();

      const result = await createMessage(db, 'non-existent-id', user.id, {
        role: 'user',
        content: 'Hello!',
      });

      expect(result).toBeNull();
    });

    it('updates conversation updatedAt timestamp', async () => {
      const user = await createTestUser();
      const conv = await createTestConversation(user.id);

      const [original] = await db
        .select({ updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(inArray(conversations.id, [conv.id]));

      await new Promise((r) => setTimeout(r, 10));

      const result = await createMessage(db, conv.id, user.id, {
        role: 'user',
        content: 'New message',
      });
      if (result) createdMessageIds.push(result.id);

      const [updated] = await db
        .select({ updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(inArray(conversations.id, [conv.id]));

      if (!original) throw new Error('Original conversation not found');
      if (!updated) throw new Error('Updated conversation not found');
      expect(updated.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
    });
  });
});
