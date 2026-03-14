import { eq, desc, sql } from 'drizzle-orm';
import { messages, conversations, epochs, conversationForks, type Database } from '@hushbox/db';
import { encryptMessageForStorage } from '@hushbox/crypto';
import { chargeForUsage } from '../billing/transaction-writer.js';
import { updateGroupSpending } from '../billing/budgets.js';

// ============================================================================
// Sequence Number Assignment
// ============================================================================

export interface AssignSequenceNumbersResult {
  sequences: number[];
  currentEpoch: number;
}

/**
 * Atomically increments `conversations.nextSequence` by `count` and returns
 * the assigned sequence numbers plus the current epoch.
 *
 * @param tx - Database transaction
 * @param conversationId - Conversation ID
 * @param count - Number of sequence numbers to assign (1 for user-only, 2 for chat turn)
 * @returns Array of assigned sequence numbers (lowest first) and current epoch
 * @throws Error('Conversation not found') if conversation does not exist
 */
export async function assignSequenceNumbers(
  tx: Database,
  conversationId: string,
  count: number
): Promise<AssignSequenceNumbersResult> {
  const [updated] = await tx
    .update(conversations)
    .set({
      nextSequence: sql`${conversations.nextSequence} + ${count}`,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId))
    .returning({
      baseSeq: sql<number>`${conversations.nextSequence} - ${count}`,
      currentEpoch: conversations.currentEpoch,
    });

  if (!updated) {
    throw new Error('Conversation not found');
  }

  const sequences = Array.from({ length: count }, (_, index) => updated.baseSeq + index);

  return { sequences, currentEpoch: updated.currentEpoch };
}

// ============================================================================
// Epoch Public Key Fetch
// ============================================================================

export interface EpochKeyResult {
  epochPublicKey: Uint8Array;
  epochNumber: number;
}

/**
 * Fetches the epoch public key for a conversation's current epoch.
 *
 * @throws Error('Epoch not found') if epoch does not exist
 */
export async function fetchEpochPublicKey(
  tx: Database,
  conversationId: string,
  currentEpoch: number
): Promise<EpochKeyResult> {
  const [epoch] = await tx
    .select({ epochPublicKey: epochs.epochPublicKey })
    .from(epochs)
    .where(
      sql`${epochs.conversationId} = ${conversationId} AND ${epochs.epochNumber} = ${currentEpoch}`
    );

  if (!epoch) {
    throw new Error('Epoch not found');
  }

  return { epochPublicKey: epoch.epochPublicKey, epochNumber: currentEpoch };
}

// ============================================================================
// Encrypted Message Insertion
// ============================================================================

export interface InsertEncryptedMessageParams {
  id: string;
  conversationId: string;
  content: string;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  senderType: 'user' | 'ai';
  senderId?: string;
  modelName?: string;
  payerId?: string;
  cost?: string;
  parentMessageId: string | null;
}

/**
 * Encrypts content with the epoch public key and inserts into the messages table.
 * Optional fields passed as `undefined` are omitted from the INSERT (DB defaults apply).
 */
export async function insertEncryptedMessage(
  tx: Database,
  params: InsertEncryptedMessageParams
): Promise<void> {
  const blob = encryptMessageForStorage(params.epochPublicKey, params.content);

  await tx.insert(messages).values({
    id: params.id,
    conversationId: params.conversationId,
    encryptedBlob: blob,
    senderType: params.senderType,
    senderId: params.senderId,
    modelName: params.modelName,
    payerId: params.payerId,
    cost: params.cost,
    epochNumber: params.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
  });
}

// ============================================================================
// Billing: Charge and Track Usage
// ============================================================================

export interface ChargeAndTrackUsageParams {
  userId: string;
  cost: string;
  model: string;
  assistantMessageId: string;
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  groupBillingContext?: { memberId: string };
}

export interface ChargeAndTrackUsageResult {
  usageRecordId: string;
}

/**
 * Charges the user's wallet for usage and optionally updates group spending tables.
 */
export async function chargeAndTrackUsage(
  tx: Database,
  params: ChargeAndTrackUsageParams
): Promise<ChargeAndTrackUsageResult> {
  const chargeResult = await chargeForUsage(tx, {
    userId: params.userId,
    cost: params.cost,
    model: params.model,
    provider: 'openrouter',
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cachedTokens: params.cachedTokens,
    sourceType: 'message',
    sourceId: params.assistantMessageId,
  });

  if (params.groupBillingContext !== undefined) {
    await updateGroupSpending(tx, {
      conversationId: params.conversationId,
      memberId: params.groupBillingContext.memberId,
      costDollars: params.cost,
    });
  }

  return { usageRecordId: chargeResult.usageRecordId };
}

// ============================================================================
// Resolve Parent Message ID
// ============================================================================

/**
 * Resolves the parentMessageId for a new user message.
 *
 * - With forkId: returns the fork's tipMessageId
 * - Without forkId: returns the latest message in the conversation by sequence number
 * - Empty conversation: returns null (first message has no parent)
 */
export async function resolveParentMessageId(
  db: Database,
  conversationId: string,
  forkId?: string
): Promise<string | null> {
  if (forkId) {
    const [fork] = await db
      .select({ tipMessageId: conversationForks.tipMessageId })
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    return fork?.tipMessageId ?? null;
  }

  const [lastMsg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sequenceNumber))
    .limit(1);
  return lastMsg?.id ?? null;
}

// ============================================================================
// Fork Tip Update
// ============================================================================

/**
 * Updates the tip message ID for a fork.
 * No-op if forkId is undefined.
 */
export async function updateForkTip(
  tx: Database,
  forkId: string,
  tipMessageId: string
): Promise<void> {
  await tx.update(conversationForks).set({ tipMessageId }).where(eq(conversationForks.id, forkId));
}
