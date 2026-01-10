import { eq, and, desc, asc } from 'drizzle-orm';
import {
  conversations,
  messages,
  type Database,
  type Conversation,
  type Message,
} from '@lome-chat/db';

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
    title = params.firstMessage.content.slice(0, 50);
  }

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(conversations)
      .values({
        userId,
        title: title ?? 'New Conversation',
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
