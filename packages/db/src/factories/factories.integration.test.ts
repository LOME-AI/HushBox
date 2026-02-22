import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { users, conversations, messages, projects } from '../schema/index';
import { userFactory, projectFactory, conversationFactory, messageFactory } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

describe('factory integration', () => {
  let db: Database;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];
  const createdProjectIds: string[] = [];

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (createdProjectIds.length > 0) {
      await db.delete(projects).where(inArray(projects.id, createdProjectIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  });

  it('inserts factory-built records with proper relationships', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning();
    if (user === undefined) {
      throw new Error('User insert failed - no record returned');
    }
    createdUserIds.push(user.id);

    const [conv] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (conv === undefined) {
      throw new Error('Conversation insert failed - no record returned');
    }
    createdConversationIds.push(conv.id);

    const [msg] = await db
      .insert(messages)
      .values(messageFactory.build({ conversationId: conv.id }))
      .returning();
    if (msg === undefined) {
      throw new Error('Message insert failed - no record returned');
    }
    createdMessageIds.push(msg.id);

    const [proj] = await db
      .insert(projects)
      .values(projectFactory.build({ userId: user.id }))
      .returning();
    if (proj === undefined) {
      throw new Error('Project insert failed - no record returned');
    }
    createdProjectIds.push(proj.id);

    expect(conv.userId).toBe(user.id);
    expect(msg.conversationId).toBe(conv.id);
    expect(proj.userId).toBe(user.id);
  });

  it('fails to insert with non-existent FK (safety net)', async () => {
    const conv = conversationFactory.build();
    await expect(db.insert(conversations).values(conv)).rejects.toThrow();
  });
});
