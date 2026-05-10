import { eq } from 'drizzle-orm';
import { messages, type Database, type DatabaseClient } from '@hushbox/db';
import {
  assignSequenceNumbers,
  fetchEpochPublicKey,
  insertEnvelopeTextMessage,
  chargeAndTrackUsage,
  updateForkTip,
} from './message-helpers.js';
import { deleteMessagesAfterAnchor } from './message-deletion.js';
import type { PersistedEnvelope } from './message-persistence.js';

interface SharedBillingParams {
  conversationId: string;
  userId: string;
  assistantMessageId: string;
  assistantContent: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  groupBillingContext?: { memberId: string };
  forkId?: string;
  /**
   * Tip the caller observed at request validation time. Threaded into
   * `updateForkTip` so a concurrent writer that already advanced the tip
   * causes a conflict, not silent overwrite.
   */
  forkTipExpectedMessageId?: string;
}

interface InsertChargeAndFinalizeForkParams extends SharedBillingParams {
  epochPublicKey: Uint8Array;
  epochNumber: number;
  aiSequence: number;
  parentMessageId: string;
}

interface InsertChargeResult {
  cost: string;
  usageRecordId: string;
  envelope: PersistedEnvelope;
}

/**
 * Persists a single-text AI message under a wrap-once envelope, charges the user's
 * wallet, and optionally updates the fork tip. Shared by both
 * saveRegeneratedResponse and saveEditedChatTurn.
 */
async function insertChargeAndFinalizeFork(
  txDb: DatabaseClient,
  params: InsertChargeAndFinalizeForkParams
): Promise<InsertChargeResult> {
  const costAmount = params.totalCost.toFixed(8);

  const persisted = await insertEnvelopeTextMessage(txDb, {
    id: params.assistantMessageId,
    conversationId: params.conversationId,
    textContent: params.assistantContent,
    epochPublicKey: params.epochPublicKey,
    epochNumber: params.epochNumber,
    sequenceNumber: params.aiSequence,
    senderType: 'ai',
    modelName: params.model,
    cost: costAmount,
    parentMessageId: params.parentMessageId,
  });

  const { usageRecordId } = await chargeAndTrackUsage(txDb, {
    userId: params.userId,
    cost: costAmount,
    model: params.model,
    assistantMessageId: params.assistantMessageId,
    conversationId: params.conversationId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    ...(params.cachedTokens !== undefined && { cachedTokens: params.cachedTokens }),
    ...(params.groupBillingContext !== undefined && {
      groupBillingContext: params.groupBillingContext,
    }),
  });

  if (params.forkId) {
    // forkTipMessageId is the tip captured during request validation; the
    // conditional update enforces nobody else moved the tip in the meantime.
    await updateForkTip(
      txDb,
      params.forkId,
      params.assistantMessageId,
      params.forkTipExpectedMessageId ?? null
    );
  }

  return {
    cost: costAmount,
    usageRecordId,
    envelope: {
      messageId: params.assistantMessageId,
      wrappedContentKey: persisted.wrappedContentKey,
      contentItem: persisted.contentItem,
    },
  };
}

interface BuildChargeParamsInput {
  params: SharedBillingParams;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  aiSequence: number;
  parentMessageId: string;
}

function buildChargeParams(input: BuildChargeParamsInput): InsertChargeAndFinalizeForkParams {
  const { params, epochPublicKey, epochNumber, aiSequence, parentMessageId } = input;
  return {
    conversationId: params.conversationId,
    userId: params.userId,
    assistantMessageId: params.assistantMessageId,
    assistantContent: params.assistantContent,
    model: params.model,
    totalCost: params.totalCost,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    ...(params.cachedTokens !== undefined && { cachedTokens: params.cachedTokens }),
    ...(params.groupBillingContext !== undefined && {
      groupBillingContext: params.groupBillingContext,
    }),
    ...(params.forkId !== undefined && { forkId: params.forkId }),
    ...(params.forkTipExpectedMessageId !== undefined && {
      forkTipExpectedMessageId: params.forkTipExpectedMessageId,
    }),
    epochPublicKey,
    epochNumber,
    aiSequence,
    parentMessageId,
  };
}

interface SequenceAndEpochResult {
  sequences: number[];
  epochPublicKey: Uint8Array;
  epochNumber: number;
}

/**
 * Assigns sequence numbers and fetches the epoch public key for a conversation.
 * Shared by both saveRegeneratedResponse and saveEditedChatTurn.
 */
async function assignSequencesAndFetchEpoch(
  txDb: DatabaseClient,
  conversationId: string,
  count: number
): Promise<SequenceAndEpochResult> {
  const { sequences, currentEpoch } = await assignSequenceNumbers(txDb, conversationId, count);
  const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
    txDb,
    conversationId,
    currentEpoch
  );
  return { sequences, epochPublicKey, epochNumber };
}

export interface SaveRegeneratedResponseParams extends SharedBillingParams {
  anchorMessageId: string;
  forkTipMessageId?: string;
}

export interface SaveRegeneratedResponseResult {
  aiSequence: number;
  epochNumber: number;
  cost: string;
  usageRecordId: string;
  envelope: PersistedEnvelope;
}

/**
 * Atomically deletes messages after the anchor, inserts a new AI response,
 * assigns a sequence number, encrypts with epoch public key, and charges
 * the user's wallet.
 *
 * Used for retry/regenerate: the anchor is the user message to regenerate from.
 * All messages after it are deleted, then a fresh AI response is inserted.
 */
export async function saveRegeneratedResponse(
  db: Database,
  params: SaveRegeneratedResponseParams
): Promise<SaveRegeneratedResponseResult> {
  const { conversationId, anchorMessageId, forkTipMessageId } = params;

  return db.transaction(async (tx) => {
    const txDb = tx;

    await deleteMessagesAfterAnchor(txDb, {
      conversationId,
      anchorMessageId,
      ...(forkTipMessageId !== undefined && { forkTipMessageId }),
    });

    const { sequences, epochPublicKey, epochNumber } = await assignSequencesAndFetchEpoch(
      txDb,
      conversationId,
      1
    );
    const aiSeq = sequences[0];
    if (aiSeq === undefined) throw new Error('invariant: expected at least one sequence number');

    const chargeParams = buildChargeParams({
      params: {
        ...params,
        ...(forkTipMessageId !== undefined && { forkTipExpectedMessageId: forkTipMessageId }),
      },
      epochPublicKey,
      epochNumber,
      aiSequence: aiSeq,
      parentMessageId: anchorMessageId,
    });
    const { cost, usageRecordId, envelope } = await insertChargeAndFinalizeFork(txDb, chargeParams);

    return {
      aiSequence: aiSeq,
      epochNumber,
      cost,
      usageRecordId,
      envelope,
    };
  });
}

export interface SaveEditedChatTurnParams extends SharedBillingParams {
  senderId: string;
  targetMessageId: string;
  newUserMessageId: string;
  newUserContent: string;
  forkTipMessageId?: string;
}

export interface SaveEditedChatTurnResult {
  userSequence: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  usageRecordId: string;
  userEnvelope: PersistedEnvelope;
  assistantEnvelope: PersistedEnvelope;
}

/**
 * Atomically edits a user message: looks up the target's parent, deletes from
 * that parent onward, then inserts a new user message + AI response pair.
 *
 * The new user message takes the place of the target in the parent chain.
 * The new AI response is parented to the new user message.
 */
export async function saveEditedChatTurn(
  db: Database,
  params: SaveEditedChatTurnParams
): Promise<SaveEditedChatTurnResult> {
  const {
    conversationId,
    senderId,
    targetMessageId,
    newUserMessageId,
    newUserContent,
    forkTipMessageId,
  } = params;

  return db.transaction(async (tx) => {
    const txDb = tx;

    const [targetMsg] = await txDb
      .select({ parentMessageId: messages.parentMessageId })
      .from(messages)
      .where(eq(messages.id, targetMessageId));

    if (!targetMsg) {
      throw new Error('Target message not found');
    }

    const targetParentId = targetMsg.parentMessageId;

    const forkTipSpread = forkTipMessageId === undefined ? {} : { forkTipMessageId };
    if (targetParentId) {
      await deleteMessagesAfterAnchor(txDb, {
        conversationId,
        anchorMessageId: targetParentId,
        ...forkTipSpread,
      });
    } else {
      await deleteMessagesAfterAnchor(txDb, {
        conversationId,
        anchorMessageId: targetMessageId,
        ...forkTipSpread,
      });
      await txDb.delete(messages).where(eq(messages.id, targetMessageId));
    }

    const { sequences, epochPublicKey, epochNumber } = await assignSequencesAndFetchEpoch(
      txDb,
      conversationId,
      2
    );
    const [userSeq, aiSeq] = sequences as [number, number];

    const userPersisted = await insertEnvelopeTextMessage(txDb, {
      id: newUserMessageId,
      conversationId,
      textContent: newUserContent,
      epochPublicKey,
      epochNumber,
      sequenceNumber: userSeq,
      senderType: 'user',
      senderId,
      parentMessageId: targetParentId ?? null,
    });

    const chargeParams = buildChargeParams({
      params: {
        ...params,
        ...(forkTipMessageId !== undefined && { forkTipExpectedMessageId: forkTipMessageId }),
      },
      epochPublicKey,
      epochNumber,
      aiSequence: aiSeq,
      parentMessageId: newUserMessageId,
    });
    const { cost, usageRecordId, envelope } = await insertChargeAndFinalizeFork(txDb, chargeParams);

    return {
      userSequence: userSeq,
      aiSequence: aiSeq,
      epochNumber,
      cost,
      usageRecordId,
      userEnvelope: {
        messageId: newUserMessageId,
        wrappedContentKey: userPersisted.wrappedContentKey,
        contentItem: userPersisted.contentItem,
      },
      assistantEnvelope: envelope,
    };
  });
}
