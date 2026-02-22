import { eq, and, desc, asc, gte, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  conversations,
  messages,
  epochs,
  epochMembers,
  conversationMembers,
  users,
  type Database,
  type Conversation,
  type Message,
} from '@hushbox/db';

export interface ConversationListRow {
  conversation: Conversation;
  acceptedAt: Date | null;
  invitedByUsername: string | null;
  privilege: string;
}

export interface ConversationWithMessages {
  conversation: Conversation;
  messages: Message[];
  acceptedAt: Date | null;
  invitedByUsername: string | null;
}

export interface UpdateConversationParams {
  title: Uint8Array;
  titleEpochNumber: number;
}

export interface CreateOrGetConversationParams {
  id: string; // REQUIRED - client must provide UUID
  title?: Uint8Array | undefined; // encrypted title from client
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
  memberWrap: Uint8Array;
  userPublicKey: Uint8Array;
}

export interface CreateOrGetConversationResult {
  conversation: Conversation;
  messages?: Message[] | undefined; // All messages when returning existing
  isNew: boolean; // true = created, false = existing
}

// SYNC: Must match conversations schema columns (snake_case from raw SQL)
// plus virtual `is_new` from RETURNING clause. See packages/db/src/schema/conversations.ts.
interface ConversationRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  title: Uint8Array;
  project_id: string | null;
  title_epoch_number: number;
  current_epoch: number;
  next_sequence: number;
  conversation_budget: string;
  created_at: Date;
  updated_at: Date;
  is_new: boolean;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: new Uint8Array(row.title),
    projectId: row.project_id ?? null,
    titleEpochNumber: row.title_epoch_number,
    currentEpoch: row.current_epoch,
    nextSequence: row.next_sequence,
    conversationBudget: row.conversation_budget,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

/**
 * List all conversations for a user, ordered by most recently updated.
 * Includes both owned conversations and conversations the user was added to as a member.
 * Returns membership acceptance state and inviter username for each conversation.
 */
export async function listConversations(
  db: Database,
  userId: string
): Promise<ConversationListRow[]> {
  const inviter = alias(users, 'inviter');

  const rows = await db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      title: conversations.title,
      projectId: conversations.projectId,
      titleEpochNumber: conversations.titleEpochNumber,
      currentEpoch: conversations.currentEpoch,
      nextSequence: conversations.nextSequence,
      conversationBudget: conversations.conversationBudget,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      acceptedAt: conversationMembers.acceptedAt,
      invitedByUsername: inviter.username,
      privilege: conversationMembers.privilege,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
    .leftJoin(inviter, eq(conversationMembers.invitedByUserId, inviter.id))
    .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)))
    .orderBy(desc(conversations.updatedAt));

  return rows.map((row) => ({
    conversation: {
      id: row.id,
      userId: row.userId,
      title: row.title,
      projectId: row.projectId,
      titleEpochNumber: row.titleEpochNumber,
      currentEpoch: row.currentEpoch,
      nextSequence: row.nextSequence,
      conversationBudget: row.conversationBudget,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    acceptedAt: row.acceptedAt,
    invitedByUsername: row.invitedByUsername,
    privilege: row.privilege,
  }));
}

/**
 * Get a single conversation with its messages.
 * Returns null if conversation not found or user is not an active member.
 * Message visibility is automatically filtered by the member's visibleFromEpoch.
 */
export async function getConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<ConversationWithMessages | null> {
  const inviter = alias(users, 'inviter');

  const rows = await db
    .select({
      conversation: conversations,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
      acceptedAt: conversationMembers.acceptedAt,
      invitedByUsername: inviter.username,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
    .leftJoin(inviter, eq(conversationMembers.invitedByUserId, inviter.id))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const { conversation, visibleFromEpoch, acceptedAt, invitedByUsername } = row;

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(
      visibleFromEpoch > 1
        ? and(
            eq(messages.conversationId, conversationId),
            gte(messages.epochNumber, visibleFromEpoch)
          )
        : eq(messages.conversationId, conversationId)
    )
    .orderBy(asc(messages.sequenceNumber));

  return { conversation, messages: conversationMessages, acceptedAt, invitedByUsername };
}

/**
 * Creates a conversation or returns existing if ID already exists for this user.
 * Returns null if ID exists but belongs to different user (caller should return 404).
 *
 * On INSERT, atomically creates:
 * - The conversation row
 * - Epoch #1 with the provided public key and confirmation hash
 * - An epoch member linking the user's public key to the epoch
 * - A conversation member linking the user to the conversation
 *
 * Title is client-encrypted (Uint8Array). If not provided, inserts empty bytes.
 *
 * IMPORTANT: Entire operation wrapped in transaction so that:
 * - On retry, CTE will create fresh (not return empty existing)
 * - Epoch/member creation is atomic with conversation creation
 */
export async function createOrGetConversation(
  db: Database,
  userId: string,
  params: CreateOrGetConversationParams
): Promise<CreateOrGetConversationResult | null> {
  const conversationId = params.id; // Required - no fallback
  const title = params.title ?? new Uint8Array(0);

  return db.transaction(async (tx) => {
    // Single atomic query with row-level locking for concurrent requests.
    // ON CONFLICT DO UPDATE with no-op (id = EXCLUDED.id) ensures:
    // 1. If row doesn't exist: INSERT succeeds, xmax = 0
    // 2. If row exists AND same user: waits for lock, returns row with xmax != 0
    // 3. If row exists AND different user: WHERE fails, returns 0 rows
    // The WHERE clause ensures we never touch or return another user's data.
    const result = await tx.execute<ConversationRow>(sql`
      INSERT INTO ${conversations} (id, user_id, title, title_epoch_number, current_epoch, next_sequence)
      VALUES (${conversationId}, ${userId}, ${title}, 1, 1, 1)
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        WHERE ${conversations}.user_id = EXCLUDED.user_id
      RETURNING *, (xmax = 0) AS is_new
    `);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const conversation = rowToConversation(row);
    const isNew = row.is_new;

    if (!isNew) {
      // Existing conversation - fetch all messages
      const existingMessages = await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(asc(messages.sequenceNumber));

      return { conversation, messages: existingMessages, isNew: false };
    }

    // New conversation — create epoch infrastructure
    const [epoch] = await tx
      .insert(epochs)
      .values({
        conversationId,
        epochNumber: 1,
        epochPublicKey: params.epochPublicKey,
        confirmationHash: params.confirmationHash,
        chainLink: null,
      })
      .returning();

    if (!epoch) {
      throw new Error('Failed to create epoch');
    }

    // Create epoch member for the owner
    await tx.insert(epochMembers).values({
      epochId: epoch.id,
      memberPublicKey: params.userPublicKey,
      wrap: params.memberWrap,
      visibleFromEpoch: 1,
    });

    // Create conversation member for the owner
    await tx.insert(conversationMembers).values({
      conversationId,
      userId,
      privilege: 'owner',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
      invitedByUserId: null,
    });

    return { conversation, isNew: true };
  });
}

/**
 * Update a conversation's title.
 * Returns null if conversation not found or user doesn't own it.
 * Uses atomic conditional update - no check-then-act.
 */
export async function updateConversation(
  db: Database,
  conversationId: string,
  userId: string,
  params: UpdateConversationParams
): Promise<Conversation | null> {
  const [updated] = await db
    .update(conversations)
    .set({
      title: params.title,
      titleEpochNumber: params.titleEpochNumber,
      updatedAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning();

  return updated ?? null;
}

/**
 * Delete a conversation.
 * Returns true if deleted, false if not found or user doesn't own it.
 * Messages, epochs, epoch members, and conversation members are cascade-deleted via FK constraints.
 * Uses atomic conditional delete - no check-then-act.
 */
export async function deleteConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .returning({ id: conversations.id });

  return result.length > 0;
}
