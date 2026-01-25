import { eq, and, desc, asc, sql } from 'drizzle-orm';
import {
  conversations,
  messages,
  type Database,
  type Conversation,
  type Message,
} from '@lome-chat/db';
import { generateChatTitle, DEFAULT_CHAT_TITLE } from '@lome-chat/shared';

export interface ConversationWithMessages {
  conversation: Conversation;
  messages: Message[];
}

export interface CreateConversationParams {
  title?: string | undefined;
  firstMessage?: { content: string } | undefined;
}

export interface CreateConversationResult {
  conversation: Conversation;
  message?: Message | undefined;
}

export interface UpdateConversationParams {
  title: string;
}

export interface CreateMessageParams {
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string | undefined;
}

export interface CreateOrGetConversationParams {
  id: string; // REQUIRED - client must provide UUID
  title?: string | undefined;
  firstMessage?: { content: string } | undefined;
}

export interface CreateOrGetConversationResult {
  conversation: Conversation;
  message?: Message | undefined; // First message when newly created
  messages?: Message[] | undefined; // All messages when returning existing
  isNew: boolean; // true = created, false = existing
}

/**
 * List all conversations for a user, ordered by most recently updated.
 */
export async function listConversations(db: Database, userId: string): Promise<Conversation[]> {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));
}

/**
 * Get a single conversation with its messages.
 * Returns null if conversation not found or user doesn't own it.
 */
export async function getConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<ConversationWithMessages | null> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  if (!conversation) {
    return null;
  }

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return { conversation, messages: conversationMessages };
}

/**
 * Create a new conversation, optionally with a first message.
 * If no title provided but firstMessage is, uses first 50 chars of message as title.
 */
export async function createConversation(
  db: Database,
  userId: string,
  params: CreateConversationParams
): Promise<CreateConversationResult> {
  let title = params.title;
  if (!title && params.firstMessage) {
    title = generateChatTitle(params.firstMessage.content);
  }

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(conversations)
      .values({
        userId,
        title: title ?? DEFAULT_CHAT_TITLE,
      })
      .returning();

    if (!conversation) {
      throw new Error('Failed to create conversation');
    }

    if (params.firstMessage) {
      const [message] = await tx
        .insert(messages)
        .values({
          conversationId: conversation.id,
          role: 'user',
          content: params.firstMessage.content,
        })
        .returning();

      return { conversation, message };
    }

    return { conversation };
  });
}

/**
 * Creates a conversation or returns existing if ID already exists for this user.
 * Returns null if ID exists but belongs to different user (caller should return 404).
 *
 * IMPORTANT: Entire operation wrapped in transaction so that:
 * - If message insert fails, conversation creation is rolled back
 * - On retry, CTE will create fresh (not return empty existing)
 */
export async function createOrGetConversation(
  db: Database,
  userId: string,
  params: CreateOrGetConversationParams
): Promise<CreateOrGetConversationResult | null> {
  const conversationId = params.id; // Required - no fallback
  const title =
    params.title ??
    (params.firstMessage ? generateChatTitle(params.firstMessage.content) : DEFAULT_CHAT_TITLE);

  return db.transaction(async (tx) => {
    // Single atomic query with row-level locking for concurrent requests.
    // ON CONFLICT DO UPDATE with no-op (id = EXCLUDED.id) ensures:
    // 1. If row doesn't exist: INSERT succeeds, xmax = 0
    // 2. If row exists AND same user: waits for lock, returns row with xmax != 0
    // 3. If row exists AND different user: WHERE fails, returns 0 rows
    // The WHERE clause ensures we never touch or return another user's data.
    const result = await tx.execute<{
      id: string;
      user_id: string;
      title: string;
      created_at: Date;
      updated_at: Date;
      is_new: boolean;
    }>(sql`
      INSERT INTO ${conversations} (id, user_id, title)
      VALUES (${conversationId}, ${userId}, ${title})
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        WHERE ${conversations}.user_id = EXCLUDED.user_id
      RETURNING *, (xmax = 0) AS is_new
    `);

    const row = result.rows[0];
    if (!row) {
      // Either insert failed OR ownership mismatch (WHERE clause failed)
      return null;
    }

    const conversation: Conversation = {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    };
    const isNew = row.is_new;

    if (isNew && params.firstMessage) {
      // New conversation - create first message (in same transaction)
      const [message] = await tx
        .insert(messages)
        .values({
          conversationId: conversation.id,
          role: 'user',
          content: params.firstMessage.content,
        })
        .returning();

      return { conversation, message, isNew: true };
    }

    if (!isNew) {
      // Existing conversation - fetch all messages
      const existingMessages = await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(asc(messages.createdAt));

      return { conversation, messages: existingMessages, isNew: false };
    }

    return { conversation, isNew: true };
  });
}

/**
 * Update a conversation's title.
 * Returns null if conversation not found or user doesn't own it.
 */
export async function updateConversation(
  db: Database,
  conversationId: string,
  userId: string,
  params: UpdateConversationParams
): Promise<Conversation | null> {
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  if (!existing) {
    return null;
  }

  const [updated] = await db
    .update(conversations)
    .set({
      title: params.title,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId))
    .returning();

  return updated ?? null;
}

/**
 * Delete a conversation.
 * Returns true if deleted, false if not found or user doesn't own it.
 * Messages are cascade-deleted via FK constraint.
 */
export async function deleteConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<boolean> {
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  if (!existing) {
    return false;
  }

  await db.delete(conversations).where(eq(conversations.id, conversationId));
  return true;
}

/**
 * Create a message in a conversation.
 * Returns null if conversation not found or user doesn't own it.
 * Updates conversation's updatedAt timestamp atomically.
 */
export async function createMessage(
  db: Database,
  conversationId: string,
  userId: string,
  params: CreateMessageParams
): Promise<Message | null> {
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  if (!existing) {
    return null;
  }

  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(messages)
      .values({
        conversationId,
        role: params.role,
        content: params.content,
        model: params.model,
      })
      .returning();

    if (!message) {
      throw new Error('Failed to create message');
    }

    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    return message;
  });
}
