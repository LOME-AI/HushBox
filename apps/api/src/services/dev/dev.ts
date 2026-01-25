import { like, eq, count, inArray } from 'drizzle-orm';
import { users, conversations, messages, projects, guestUsage, type Database } from '@lome-chat/db';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN, type DevPersona } from '@lome-chat/shared';

export interface ResetGuestUsageResult {
  deleted: number;
}

export interface CleanupResult {
  conversations: number;
  messages: number;
}

/**
 * List dev or test personas with their stats.
 */
export async function listDevPersonas(db: Database, type: 'dev' | 'test'): Promise<DevPersona[]> {
  const emailDomain = type === 'test' ? TEST_EMAIL_DOMAIN : DEV_EMAIL_DOMAIN;

  const devUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      image: users.image,
      balance: users.balance,
    })
    .from(users)
    .where(like(users.email, `%@${emailDomain}`));

  const personas: DevPersona[] = await Promise.all(
    devUsers.map(async (user) => {
      const [convCount] = await db
        .select({ count: count() })
        .from(conversations)
        .where(eq(conversations.userId, user.id));

      const [msgCount] = await db
        .select({ count: count() })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.userId, user.id));

      const [projCount] = await db
        .select({ count: count() })
        .from(projects)
        .where(eq(projects.userId, user.id));

      const balanceNumber = Number.parseFloat(user.balance);
      const formattedCredits = `$${balanceNumber.toFixed(2)}`;

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        stats: {
          conversationCount: convCount?.count ?? 0,
          messageCount: msgCount?.count ?? 0,
          projectCount: projCount?.count ?? 0,
        },
        credits: formattedCredits,
      };
    })
  );

  return personas;
}

/**
 * Clean up test user data (conversations and messages).
 * Returns count of deleted items.
 */
export async function cleanupTestData(db: Database): Promise<CleanupResult> {
  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${TEST_EMAIL_DOMAIN}`));

  const testUserIds = testUsers.map((u) => u.id);

  if (testUserIds.length === 0) {
    return { conversations: 0, messages: 0 };
  }

  const testConvs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.userId, testUserIds));

  const convIds = testConvs.map((conv) => conv.id);

  if (convIds.length === 0) {
    return { conversations: 0, messages: 0 };
  }

  // Delete messages first (FK constraint)
  const msgResult = await db.delete(messages).where(inArray(messages.conversationId, convIds));
  const deletedMessages = msgResult.rowCount ?? 0;

  // Delete conversations
  const convResult = await db.delete(conversations).where(inArray(conversations.id, convIds));
  const deletedConversations = convResult.rowCount ?? 0;

  return { conversations: deletedConversations, messages: deletedMessages };
}

/**
 * Reset all guest usage records for testing purposes.
 * This deletes all records from the guest_usage table.
 */
export async function resetGuestUsage(db: Database): Promise<ResetGuestUsageResult> {
  const deleted = await db.delete(guestUsage).returning();
  return { deleted: deleted.length };
}
