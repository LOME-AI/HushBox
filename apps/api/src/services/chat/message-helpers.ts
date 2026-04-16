import { eq, and, desc, sql } from 'drizzle-orm';
import {
  messages,
  contentItems,
  conversations,
  epochs,
  conversationForks,
  type Database,
} from '@hushbox/db';
import { beginMessageEnvelope, encryptTextWithContentKey } from '@hushbox/crypto';
import { ERROR_CODE_INVALID_PARENT_MESSAGE } from '@hushbox/shared';
import { chargeForUsage, chargeForMediaGeneration } from '../billing/transaction-writer.js';
import { updateGroupSpending } from '../billing/budgets.js';

// ============================================================================
// Parent Message Validation
// ============================================================================

export class InvalidParentMessageError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'InvalidParentMessageError';
  }
}

/**
 * Validates that parentMessageId is correct before persisting a message.
 *
 * - null parentMessageId: only valid for the first message in a conversation
 * - non-null parentMessageId: must reference an existing message in the same conversation
 *
 * Runs inside a transaction to guarantee atomicity.
 */
export async function validateParentMessageId(
  tx: Database,
  conversationId: string,
  parentMessageId: string | null
): Promise<void> {
  if (parentMessageId === null) {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .limit(1);

    if (existing) {
      throw new InvalidParentMessageError(
        ERROR_CODE_INVALID_PARENT_MESSAGE,
        'parentMessageId is null but conversation already has messages'
      );
    }
    return;
  }

  const [parent] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, parentMessageId), eq(messages.conversationId, conversationId)));

  if (!parent) {
    throw new InvalidParentMessageError(
      ERROR_CODE_INVALID_PARENT_MESSAGE,
      `parentMessageId "${parentMessageId}" not found in conversation "${conversationId}"`
    );
  }
}

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
// Envelope Message Insertion (wrap-once)
// ============================================================================

export interface InsertEnvelopeTextMessageParams {
  id: string;
  conversationId: string;
  textContent: string;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  senderType: 'user' | 'ai';
  senderId?: string;
  modelName?: string;
  cost?: string;
  isSmartModel?: boolean;
  parentMessageId: string | null;
}

export interface InsertedTextContentItem {
  id: string;
  contentType: 'text';
  position: number;
  encryptedBlob: Uint8Array;
  modelName: string | null;
  cost: string | null;
  isSmartModel: boolean;
}

export interface InsertEnvelopeTextMessageResult {
  wrappedContentKey: Uint8Array;
  contentItem: InsertedTextContentItem;
}

/**
 * Persists a single-text-content message under the wrap-once envelope model.
 *
 * Generates a fresh content key, wraps it under the epoch public key, encrypts the
 * plaintext under the content key, and inserts one `messages` row plus one
 * `content_items` row with `content_type = 'text'`. The content key is discarded
 * from memory after the inserts.
 *
 * Returns the `wrappedContentKey` and the inserted content item so the caller can
 * forward them to the client via the SSE `done` event.
 */
export async function insertEnvelopeTextMessage(
  tx: Database,
  params: InsertEnvelopeTextMessageParams
): Promise<InsertEnvelopeTextMessageResult> {
  const { contentKey, wrappedContentKey } = beginMessageEnvelope(params.epochPublicKey);
  const encryptedBlob = encryptTextWithContentKey(contentKey, params.textContent);

  await tx.insert(messages).values({
    id: params.id,
    conversationId: params.conversationId,
    wrappedContentKey,
    senderType: params.senderType,
    senderId: params.senderId,
    epochNumber: params.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
  });

  const contentItemId = crypto.randomUUID();
  const modelName = params.modelName ?? null;
  const cost = params.cost ?? null;
  const isSmartModel = params.isSmartModel ?? false;

  await tx.insert(contentItems).values({
    id: contentItemId,
    messageId: params.id,
    contentType: 'text',
    position: 0,
    encryptedBlob,
    modelName,
    cost,
    isSmartModel,
  });

  return {
    wrappedContentKey,
    contentItem: {
      id: contentItemId,
      contentType: 'text',
      position: 0,
      encryptedBlob,
      modelName,
      cost,
      isSmartModel,
    },
  };
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
    provider: 'ai-gateway',
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
// Envelope Media Message Insertion
// ============================================================================

export type MediaContentType = 'image' | 'audio' | 'video';

export interface MediaContentItemInput {
  id: string;
  contentType: MediaContentType;
  position: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  modelName: string;
  cost: string;
  isSmartModel: boolean;
}

export interface InsertedMediaContentItem {
  id: string;
  contentType: MediaContentType;
  position: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  modelName: string;
  cost: string;
  isSmartModel: boolean;
}

export interface InsertEnvelopeMediaMessageParams {
  id: string;
  conversationId: string;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  senderType: 'ai';
  parentMessageId: string | null;
  mediaItems: MediaContentItemInput[];
}

export interface InsertEnvelopeMediaMessageResult {
  wrappedContentKey: Uint8Array;
  contentItems: InsertedMediaContentItem[];
}

/**
 * Persists a media message under the wrap-once envelope model.
 *
 * Generates a fresh content key, wraps it under the epoch public key, and
 * inserts one `messages` row plus N `content_items` rows for pre-encrypted
 * media items. The content key is discarded — the caller uses it externally
 * for R2 encryption before calling this function.
 */
export async function insertEnvelopeMediaMessage(
  tx: Database,
  params: InsertEnvelopeMediaMessageParams
): Promise<InsertEnvelopeMediaMessageResult> {
  const { wrappedContentKey } = beginMessageEnvelope(params.epochPublicKey);

  await tx.insert(messages).values({
    id: params.id,
    conversationId: params.conversationId,
    wrappedContentKey,
    senderType: params.senderType,
    epochNumber: params.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
  });

  const insertedItems: InsertedMediaContentItem[] = [];

  for (const item of params.mediaItems) {
    const resolved: InsertedMediaContentItem = {
      id: item.id,
      contentType: item.contentType,
      position: item.position,
      storageKey: item.storageKey,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width ?? null,
      height: item.height ?? null,
      durationMs: item.durationMs ?? null,
      modelName: item.modelName,
      cost: item.cost,
      isSmartModel: item.isSmartModel,
    };

    await tx.insert(contentItems).values({
      ...resolved,
      messageId: params.id,
    });

    insertedItems.push(resolved);
  }

  return { wrappedContentKey, contentItems: insertedItems };
}

// ============================================================================
// Billing: Charge and Track Media Usage
// ============================================================================

export interface ChargeAndTrackMediaUsageParams {
  userId: string;
  cost: string;
  model: string;
  assistantMessageId: string;
  conversationId: string;
  mediaType: MediaContentType;
  imageCount?: number;
  durationMs?: number;
  resolution?: string;
  groupBillingContext?: { memberId: string };
}

export interface ChargeAndTrackMediaUsageResult {
  usageRecordId: string;
}

/**
 * Charges the user's wallet for media generation usage and optionally updates group spending.
 */
export async function chargeAndTrackMediaUsage(
  tx: Database,
  params: ChargeAndTrackMediaUsageParams
): Promise<ChargeAndTrackMediaUsageResult> {
  const chargeResult = await chargeForMediaGeneration(tx, {
    userId: params.userId,
    cost: params.cost,
    model: params.model,
    provider: 'ai-gateway',
    mediaType: params.mediaType,
    imageCount: params.imageCount,
    durationMs: params.durationMs,
    resolution: params.resolution,
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
