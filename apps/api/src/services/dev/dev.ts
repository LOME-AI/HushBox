import { like, eq, count, inArray, and } from 'drizzle-orm';
import {
  users,
  wallets,
  ledgerEntries,
  conversations,
  messages,
  projects,
  epochs,
  epochMembers,
  conversationMembers,
  type Database,
} from '@hushbox/db';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN, type DevPersona } from '@hushbox/shared';
import { createFirstEpoch, encryptMessageForStorage } from '@hushbox/crypto';
import { checkUserBalance } from '../billing/index.js';
import { createOrGetConversation } from '../conversations/index.js';
import { saveUserOnlyMessage } from '../chat/index.js';
import {
  insertEncryptedMessage,
  assignSequenceNumbers,
  fetchEpochPublicKey,
} from '../chat/message-helpers.js';
import type { Redis } from '@upstash/redis';

export interface ResetTrialUsageResult {
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
      username: users.username,
      email: users.email,
      emailVerified: users.emailVerified,
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

      const balanceResult = await checkUserBalance(db, user.id);
      const balanceNumber = Number.parseFloat(balanceResult.currentBalance);
      const formattedCredits = `$${balanceNumber.toFixed(2)}`;

      return {
        id: user.id,
        username: user.username,
        email: user.email ?? '', // Dev personas always have email (filtered by email domain)
        emailVerified: user.emailVerified,
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
 * Reset all trial usage records for testing purposes.
 * Scans Redis for trial:token:* and trial:ip:* keys and deletes them.
 */
export async function resetTrialUsage(redis: Redis): Promise<ResetTrialUsageResult> {
  let deleted = 0;
  let cursor: string | number = 0;

  do {
    const [nextCursor, keys]: [string, string[]] = await redis.scan(cursor, {
      match: 'trial:*',
      count: 100,
    });
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');

  return { deleted };
}

export interface ResetAuthRateLimitsResult {
  deleted: number;
}

/**
 * Reset all auth-related rate limits, lockouts, and TOTP replay keys for testing.
 * Scans Redis for each auth-related prefix and deletes matching keys.
 */
export async function resetAuthRateLimits(redis: Redis): Promise<ResetAuthRateLimitsResult> {
  const prefixes = [
    'login:*:ratelimit:*',
    'login:lockout:*',
    'register:*:ratelimit:*',
    '2fa:*:ratelimit:*',
    '2fa:lockout:*',
    'recovery:*:ratelimit:*',
    'recovery:lockout:*',
    'verify:*:ratelimit:*',
    'resend-verify:*:ratelimit:*',
    'totp:used:*',
  ];

  let deleted = 0;

  for (const prefix of prefixes) {
    let cursor: string | number = 0;
    do {
      const [nextCursor, keys]: [string, string[]] = await redis.scan(cursor, {
        match: prefix,
        count: 100,
      });
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
  }

  return { deleted };
}

export interface CreateDevConversationParams {
  ownerEmail: string;
  messages?:
    | {
        content: string;
        senderType: 'user' | 'ai';
      }[]
    | undefined;
}

export interface CreateDevConversationResult {
  conversationId: string;
}

/**
 * Create a single-user conversation for E2E testing.
 * Uses production services (createOrGetConversation, saveUserOnlyMessage) to avoid
 * duplicating DB insertion logic. Server-side crypto generation via createFirstEpoch.
 */
export async function createDevConversation(
  db: Database,
  params: CreateDevConversationParams
): Promise<CreateDevConversationResult> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(eq(users.email, params.ownerEmail));

  if (!user) {
    throw new Error(`User not found: ${params.ownerEmail}`);
  }

  const epochResult = createFirstEpoch([user.publicKey]);
  const conversationId = crypto.randomUUID();

  const result = await createOrGetConversation(db, user.id, {
    id: conversationId,
    epochPublicKey: epochResult.epochPublicKey,
    confirmationHash: epochResult.confirmationHash,
    memberWrap: (() => {
      const wrap = epochResult.memberWraps[0];
      if (!wrap) throw new Error('invariant: missing member wrap');
      return wrap.wrap;
    })(),
    userPublicKey: user.publicKey,
  });

  if (!result) {
    throw new Error('Failed to create conversation');
  }

  // Seed messages using production services
  if (params.messages && params.messages.length > 0) {
    let lastMessageId: string | null = null;

    for (const msg of params.messages) {
      const messageId = crypto.randomUUID();

      if (msg.senderType === 'user') {
        await saveUserOnlyMessage(db, {
          conversationId: result.conversation.id,
          userId: user.id,
          senderId: user.id,
          messageId,
          content: msg.content,
          parentMessageId: lastMessageId,
        });
      } else {
        // AI messages: use production helpers directly in a transaction
        await db.transaction(async (tx) => {
          const txDb = tx as unknown as Database;
          const { sequences, currentEpoch } = await assignSequenceNumbers(
            txDb,
            result.conversation.id,
            1
          );
          const seq = sequences[0];
          if (seq === undefined) throw new Error('invariant: expected sequence number');

          const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
            txDb,
            result.conversation.id,
            currentEpoch
          );

          await insertEncryptedMessage(txDb, {
            id: messageId,
            conversationId: result.conversation.id,
            content: msg.content,
            epochPublicKey,
            epochNumber,
            sequenceNumber: seq,
            senderType: 'ai',
            modelName: 'anthropic/claude-3.5-sonnet',
            parentMessageId: lastMessageId,
          });
        });
      }

      lastMessageId = messageId;
    }
  }

  return { conversationId: result.conversation.id };
}

export interface CreateDevGroupChatParams {
  ownerEmail: string;
  memberEmails: string[];
  messages?: {
    senderEmail?: string;
    content: string;
    senderType: 'user' | 'ai';
  }[];
}

export interface CreateDevGroupChatResult {
  conversationId: string;
  members: { userId: string; username: string; email: string }[];
}

/**
 * Create a group conversation with epoch crypto for E2E testing.
 * Mirrors the seed script's createConversationEpochData pattern.
 */
export async function createDevGroupChat(
  db: Database,
  params: CreateDevGroupChatParams
): Promise<CreateDevGroupChatResult> {
  const allEmails = [params.ownerEmail, ...params.memberEmails];

  const foundUsers = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(inArray(users.email, allEmails));

  const owner = foundUsers.find((u) => u.email === params.ownerEmail);
  if (!owner) {
    throw new Error(`Owner not found: ${params.ownerEmail}`);
  }

  // Order: owner first, then members in request order
  const orderedUsers = [
    owner,
    ...params.memberEmails.map((email) => {
      const found = foundUsers.find((u) => u.email === email);
      if (!found) throw new Error(`Member not found: ${email}`);
      return found;
    }),
  ];

  const publicKeys = orderedUsers.map((u) => u.publicKey);
  const epochResult = createFirstEpoch(publicKeys);

  const conversationId = crypto.randomUUID();
  const epochId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    // Insert conversation
    await tx.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      title: encryptMessageForStorage(epochResult.epochPublicKey, ''),
    });

    // Insert epoch
    await tx.insert(epochs).values({
      id: epochId,
      conversationId,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
      chainLink: null,
    });

    // Insert epoch members (one per user with their wrap)
    await tx.insert(epochMembers).values(
      orderedUsers.map((user, index) => {
        const memberWrap = epochResult.memberWraps[index];
        if (!memberWrap)
          throw new Error(`invariant: member wrap missing at index ${String(index)}`);
        return {
          id: crypto.randomUUID(),
          epochId,
          memberPublicKey: user.publicKey,
          wrap: memberWrap.wrap,
          privilege: index === 0 ? 'owner' : ('admin' as string),
          visibleFromEpoch: 1,
        };
      })
    );

    // Insert conversation members (acceptedAt set so they're not treated as pending invites)
    await tx.insert(conversationMembers).values(
      orderedUsers.map((user, index) => ({
        id: crypto.randomUUID(),
        conversationId,
        userId: user.id,
        privilege: index === 0 ? 'owner' : ('admin' as string),
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
      }))
    );

    // Insert messages if provided
    if (params.messages && params.messages.length > 0) {
      const messageIds = params.messages.map(() => crypto.randomUUID());
      await tx.insert(messages).values(
        params.messages.map((msg, index) => {
          const senderId =
            msg.senderType === 'user' && msg.senderEmail
              ? (orderedUsers.find((u) => u.email != null && u.email === msg.senderEmail)?.id ??
                null)
              : null;

          const msgId = messageIds[index];
          if (!msgId) throw new Error(`invariant: messageIds[${String(index)}] is undefined`);

          return {
            id: msgId,
            conversationId,
            encryptedBlob: encryptMessageForStorage(epochResult.epochPublicKey, msg.content),
            senderType: msg.senderType,
            senderId,
            ...(msg.senderType === 'ai' ? { modelName: 'anthropic/claude-3.5-sonnet' } : {}),
            epochNumber: 1,
            sequenceNumber: index + 1,
            ...(index > 0
              ? {
                  parentMessageId: (() => {
                    const parentId = messageIds[index - 1];
                    if (!parentId)
                      throw new Error(`invariant: messageIds[${String(index - 1)}] is undefined`);
                    return parentId;
                  })(),
                }
              : {}),
          };
        })
      );

      // Keep nextSequence in sync so saveChatTurn assigns non-overlapping sequences
      await tx
        .update(conversations)
        .set({ nextSequence: params.messages.length + 1 })
        .where(eq(conversations.id, conversationId));
    }
  });

  return {
    conversationId,
    members: orderedUsers.map((u) => ({
      userId: u.id,
      username: u.username,
      email: u.email ?? '', // Dev users always have email (looked up by email)
    })),
  };
}

export interface SetWalletBalanceParams {
  email: string;
  walletType: 'purchased' | 'free_tier';
  balance: string;
}

export interface SetWalletBalanceResult {
  newBalance: string;
}

/**
 * Set a user's wallet balance to an exact value.
 * Dev/test only — used by E2E tests to manipulate wallet state.
 */
export async function setWalletBalance(
  db: Database,
  params: SetWalletBalanceParams
): Promise<SetWalletBalanceResult> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.email.toLowerCase()));

  if (!user) {
    throw new Error(`User not found: ${params.email}`);
  }

  const [updated] = await db
    .update(wallets)
    .set({ balance: params.balance })
    .where(and(eq(wallets.userId, user.id), eq(wallets.type, params.walletType)))
    .returning({ id: wallets.id, balance: wallets.balance });

  if (!updated) {
    throw new Error(`Wallet not found: ${params.walletType} for ${params.email}`);
  }

  await db
    .insert(ledgerEntries)
    .values({
      walletId: updated.id,
      amount: params.balance,
      balanceAfter: updated.balance,
      entryType: 'adjustment',
      sourceWalletId: updated.id,
    })
    .returning({ id: ledgerEntries.id });

  return { newBalance: updated.balance };
}
