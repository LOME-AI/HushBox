import { eq, sql } from 'drizzle-orm';
import { messages, conversations, epochs, type Database } from '@hushbox/db';
import { encryptMessageForStorage } from '@hushbox/crypto';
import { chargeForUsage } from '../billing/transaction-writer.js';
import { updateGroupSpending } from '../billing/budgets.js';

interface EpochKeyResult {
  epochPublicKey: Uint8Array;
  epochNumber: number;
}

/** Fetches the epoch public key for a conversation's current epoch. */
async function fetchEpochPublicKey(
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

export interface SaveUserOnlyMessageParams {
  conversationId: string;
  userId: string;
  messageId: string;
  content: string;
}

export interface SaveUserOnlyMessageResult {
  sequenceNumber: number;
  epochNumber: number;
}

/**
 * Saves a single user message without triggering AI or billing.
 * Used in group chats when the AI toggle is off.
 * Free — no wallet charge, no usage records, no LLM completions.
 */
export async function saveUserOnlyMessage(
  db: Database,
  params: SaveUserOnlyMessageParams
): Promise<SaveUserOnlyMessageResult> {
  const { conversationId, userId, messageId, content } = params;

  return db.transaction(async (tx) => {
    // 1. Assign ONE sequence number atomically
    const [updated] = await tx
      .update(conversations)
      .set({
        nextSequence: sql`${conversations.nextSequence} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
      .returning({
        seq: sql<number>`${conversations.nextSequence} - 1`,
        currentEpoch: conversations.currentEpoch,
      });

    if (!updated) {
      throw new Error('Conversation not found');
    }

    const { seq, currentEpoch } = updated;

    // 2. Fetch epoch public key from current epoch
    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx as unknown as Database,
      conversationId,
      currentEpoch
    );

    // 3. Encrypt user message
    const blob = encryptMessageForStorage(epochPublicKey, content);

    // 4. Insert user message (no cost, no billing)
    await tx.insert(messages).values({
      id: messageId,
      conversationId,
      encryptedBlob: blob,
      senderType: 'user',
      senderId: userId,
      epochNumber,
      sequenceNumber: seq,
    });

    return { sequenceNumber: seq, epochNumber };
  });
}

export interface SaveChatTurnParams {
  conversationId: string;
  userId: string;
  userMessageId: string;
  userContent: string;
  assistantMessageId: string;
  assistantContent: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** When present, atomically increments group spending tables. Only set when a member uses the owner's balance. */
  groupBillingContext?: { memberId: string };
}

export interface SaveChatTurnResult {
  userSequence: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  usageRecordId: string;
}

/**
 * Atomically saves both user + assistant messages, assigns sequence numbers,
 * encrypts with epoch public key, and charges the user's wallet.
 *
 * All steps run inside a single database transaction. If any step fails,
 * the entire operation rolls back -- no partial state.
 */
export async function saveChatTurn(
  db: Database,
  params: SaveChatTurnParams
): Promise<SaveChatTurnResult> {
  const {
    conversationId,
    userId,
    userMessageId,
    userContent,
    assistantMessageId,
    assistantContent,
    model,
    totalCost,
    inputTokens,
    outputTokens,
    cachedTokens,
    groupBillingContext,
  } = params;

  const costAmount = totalCost.toFixed(8);

  return db.transaction(async (tx) => {
    // 1. Assign sequences atomically
    const [updated] = await tx
      .update(conversations)
      .set({
        nextSequence: sql`${conversations.nextSequence} + 2`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
      .returning({
        userSeq: sql<number>`${conversations.nextSequence} - 2`,
        aiSeq: sql<number>`${conversations.nextSequence} - 1`,
        currentEpoch: conversations.currentEpoch,
      });

    if (!updated) {
      throw new Error('Conversation not found');
    }

    const { userSeq, aiSeq, currentEpoch } = updated;

    // 2. Fetch epoch public key from current epoch
    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx as unknown as Database,
      conversationId,
      currentEpoch
    );

    // 3. Encrypt user message
    const userBlob = encryptMessageForStorage(epochPublicKey, userContent);

    // 4. Insert user message
    await tx.insert(messages).values({
      id: userMessageId,
      conversationId,
      encryptedBlob: userBlob,
      senderType: 'user',
      senderId: userId,
      epochNumber,
      sequenceNumber: userSeq,
    });

    // 5. Encrypt AI message
    const aiBlob = encryptMessageForStorage(epochPublicKey, assistantContent);

    // 6. Insert AI message
    await tx.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      encryptedBlob: aiBlob,
      senderType: 'ai',
      payerId: userId,
      cost: costAmount,
      epochNumber,
      sequenceNumber: aiSeq,
    });

    // 7. Charge wallet via chargeForUsage (pass tx for atomicity)
    const chargeResult = await chargeForUsage(tx as unknown as Database, {
      userId,
      cost: costAmount,
      model,
      provider: 'openrouter',
      inputTokens,
      outputTokens,
      cachedTokens,
      sourceType: 'message',
      sourceId: assistantMessageId,
    });

    // 8. Increment group spending tables (only when member uses owner's balance)
    if (groupBillingContext !== undefined) {
      await updateGroupSpending(tx as unknown as Database, {
        conversationId,
        memberId: groupBillingContext.memberId,
        costDollars: costAmount,
      });
    }

    return {
      userSequence: userSeq,
      aiSequence: aiSeq,
      epochNumber,
      cost: costAmount,
      usageRecordId: chargeResult.usageRecordId,
    };
  });
}
