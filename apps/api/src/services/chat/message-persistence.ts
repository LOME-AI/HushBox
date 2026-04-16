import { type Database } from '@hushbox/db';
import {
  assignSequenceNumbers,
  fetchEpochPublicKey,
  insertEnvelopeTextMessage,
  insertEnvelopeMediaMessage,
  type InsertedTextContentItem,
  type InsertedMediaContentItem,
  type MediaContentItemInput,
  type MediaContentType,
  chargeAndTrackUsage,
  chargeAndTrackMediaUsage,
  updateForkTip,
  validateParentMessageId,
} from './message-helpers.js';

export interface SaveUserOnlyMessageParams {
  conversationId: string;
  userId: string;
  senderId: string;
  messageId: string;
  content: string;
  parentMessageId: string | null;
  forkId?: string;
}

export interface PersistedTextEnvelope {
  messageId: string;
  wrappedContentKey: Uint8Array;
  contentItem: InsertedTextContentItem;
}

export interface PersistedMediaEnvelope {
  messageId: string;
  wrappedContentKey: Uint8Array;
  contentItems: InsertedMediaContentItem[];
}

export type PersistedEnvelope = PersistedTextEnvelope | PersistedMediaEnvelope;

export interface SaveUserOnlyMessageResult {
  sequenceNumber: number;
  epochNumber: number;
  envelope: PersistedEnvelope;
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
  const { conversationId, senderId, messageId, content, parentMessageId, forkId } = params;

  return db.transaction(async (tx) => {
    await validateParentMessageId(tx as unknown as Database, conversationId, parentMessageId);

    const { sequences, currentEpoch } = await assignSequenceNumbers(
      tx as unknown as Database,
      conversationId,
      1
    );
    const seq = sequences[0];
    if (seq === undefined) throw new Error('invariant: expected at least one sequence number');

    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx as unknown as Database,
      conversationId,
      currentEpoch
    );

    const { wrappedContentKey, contentItem } = await insertEnvelopeTextMessage(
      tx as unknown as Database,
      {
        id: messageId,
        conversationId,
        textContent: content,
        epochPublicKey,
        epochNumber,
        sequenceNumber: seq,
        senderType: 'user',
        senderId,
        parentMessageId,
      }
    );

    if (forkId) {
      await updateForkTip(tx as unknown as Database, forkId, messageId);
    }

    return {
      sequenceNumber: seq,
      epochNumber,
      envelope: { messageId, wrappedContentKey, contentItem },
    };
  });
}

export interface TextAssistantMessageInput {
  modality: 'text';
  id: string;
  content: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export interface MediaAssistantMessageInput {
  modality: MediaContentType;
  id: string;
  contentItems: MediaContentItemInput[];
  model: string;
  cost: number;
  mediaType: MediaContentType;
  imageCount?: number;
  durationMs?: number;
  resolution?: string;
}

export type AssistantMessageInput = TextAssistantMessageInput | MediaAssistantMessageInput;

interface SaveChatTurnBaseParams {
  conversationId: string;
  userId: string;
  senderId: string;
  userMessageId: string;
  userContent: string;
  /** When present, atomically increments group spending tables. Only set when a member uses the owner's balance. */
  groupBillingContext?: { memberId: string };
  parentMessageId: string | null;
  forkId?: string;
}

interface SaveChatTurnLegacyParams extends SaveChatTurnBaseParams {
  assistantMessageId: string;
  assistantContent: string;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

interface SaveChatTurnMultiParams extends SaveChatTurnBaseParams {
  assistantMessages: AssistantMessageInput[];
}

export type SaveChatTurnParams = SaveChatTurnLegacyParams | SaveChatTurnMultiParams;

export interface AssistantResult {
  /** The canonical assistant message id (also present on envelope.messageId). */
  assistantMessageId: string;
  /** The AI model id (e.g. `openai/gpt-4o`). Needed by SSE done-event construction. */
  model: string;
  aiSequence: number;
  cost: string;
  usageRecordId: string;
  envelope: PersistedEnvelope;
}

export interface SaveChatTurnResult {
  userSequence: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  usageRecordId: string;
  userEnvelope: PersistedEnvelope;
  assistantResults: AssistantResult[];
}

function normalizeAssistantMessages(params: SaveChatTurnParams): AssistantMessageInput[] {
  if ('assistantMessages' in params) {
    return params.assistantMessages;
  }
  return [
    {
      modality: 'text' as const,
      id: params.assistantMessageId,
      content: params.assistantContent,
      model: params.model,
      cost: params.totalCost,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      ...(params.cachedTokens !== undefined && { cachedTokens: params.cachedTokens }),
    },
  ];
}

interface PersistAssistantContext {
  conversationId: string;
  epochPublicKey: Uint8Array;
  epochNumber: number;
  sequenceNumber: number;
  userMessageId: string;
  userId: string;
  groupBillingContext?: { memberId: string };
}

async function persistTextAssistant(
  tx: Database,
  msg: TextAssistantMessageInput,
  context: PersistAssistantContext
): Promise<AssistantResult> {
  const costAmount = msg.cost.toFixed(8);
  const persisted = await insertEnvelopeTextMessage(tx, {
    id: msg.id,
    conversationId: context.conversationId,
    textContent: msg.content,
    epochPublicKey: context.epochPublicKey,
    epochNumber: context.epochNumber,
    sequenceNumber: context.sequenceNumber,
    senderType: 'ai',
    modelName: msg.model,
    cost: costAmount,
    parentMessageId: context.userMessageId,
  });

  const { usageRecordId } = await chargeAndTrackUsage(tx, {
    userId: context.userId,
    cost: costAmount,
    model: msg.model,
    assistantMessageId: msg.id,
    conversationId: context.conversationId,
    inputTokens: msg.inputTokens,
    outputTokens: msg.outputTokens,
    ...(msg.cachedTokens !== undefined && { cachedTokens: msg.cachedTokens }),
    ...(context.groupBillingContext !== undefined && {
      groupBillingContext: context.groupBillingContext,
    }),
  });

  return {
    assistantMessageId: msg.id,
    model: msg.model,
    aiSequence: context.sequenceNumber,
    cost: costAmount,
    usageRecordId,
    envelope: {
      messageId: msg.id,
      wrappedContentKey: persisted.wrappedContentKey,
      contentItem: persisted.contentItem,
    },
  };
}

async function persistMediaAssistant(
  tx: Database,
  msg: MediaAssistantMessageInput,
  context: PersistAssistantContext
): Promise<AssistantResult> {
  const costAmount = msg.cost.toFixed(8);
  const persisted = await insertEnvelopeMediaMessage(tx, {
    id: msg.id,
    conversationId: context.conversationId,
    epochPublicKey: context.epochPublicKey,
    epochNumber: context.epochNumber,
    sequenceNumber: context.sequenceNumber,
    senderType: 'ai',
    parentMessageId: context.userMessageId,
    mediaItems: msg.contentItems,
  });

  const { usageRecordId } = await chargeAndTrackMediaUsage(tx, {
    userId: context.userId,
    cost: costAmount,
    model: msg.model,
    assistantMessageId: msg.id,
    conversationId: context.conversationId,
    mediaType: msg.mediaType,
    ...(msg.imageCount !== undefined && { imageCount: msg.imageCount }),
    ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
    ...(msg.resolution !== undefined && { resolution: msg.resolution }),
    ...(context.groupBillingContext !== undefined && {
      groupBillingContext: context.groupBillingContext,
    }),
  });

  return {
    assistantMessageId: msg.id,
    model: msg.model,
    aiSequence: context.sequenceNumber,
    cost: costAmount,
    usageRecordId,
    envelope: {
      messageId: msg.id,
      wrappedContentKey: persisted.wrappedContentKey,
      contentItems: persisted.contentItems,
    },
  };
}

function logNegativeCosts(
  msgs: AssistantMessageInput[],
  conversationId: string,
  userId: string
): void {
  for (const msg of msgs) {
    if (msg.cost < 0) {
      console.error(
        JSON.stringify({
          event: 'negative_cost_detected',
          totalCost: msg.cost,
          costAmount: msg.cost.toFixed(8),
          conversationId,
          model: msg.model,
          userId,
        })
      );
    }
  }
}

async function persistAllAssistants(
  tx: Database,
  assistantMsgs: AssistantMessageInput[],
  sequences: number[],
  context: Omit<PersistAssistantContext, 'sequenceNumber'>
): Promise<AssistantResult[]> {
  const results: AssistantResult[] = [];

  for (const [index, assistantMsg] of assistantMsgs.entries()) {
    const aiSeq = sequences[1 + index];
    if (aiSeq === undefined)
      throw new Error(`invariant: expected sequence number at index ${String(1 + index)}`);

    const persistContext = { ...context, sequenceNumber: aiSeq };

    const result =
      assistantMsg.modality === 'text'
        ? await persistTextAssistant(tx, assistantMsg, persistContext)
        : await persistMediaAssistant(tx, assistantMsg, persistContext);

    results.push(result);
  }

  return results;
}

/**
 * Atomically saves user + N assistant messages, assigns sequence numbers,
 * encrypts each under a wrap-once envelope, and charges the user's wallet per model.
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
    senderId,
    userMessageId,
    userContent,
    groupBillingContext,
    parentMessageId,
    forkId,
  } = params;

  const assistantMsgs = normalizeAssistantMessages(params);
  logNegativeCosts(assistantMsgs, conversationId, userId);

  return db.transaction(async (tx) => {
    await validateParentMessageId(tx as unknown as Database, conversationId, parentMessageId);

    const { sequences, currentEpoch } = await assignSequenceNumbers(
      tx as unknown as Database,
      conversationId,
      1 + assistantMsgs.length
    );
    const userSeq = sequences[0];
    if (userSeq === undefined) throw new Error('invariant: expected at least one sequence number');

    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx as unknown as Database,
      conversationId,
      currentEpoch
    );

    const userPersisted = await insertEnvelopeTextMessage(tx as unknown as Database, {
      id: userMessageId,
      conversationId,
      textContent: userContent,
      epochPublicKey,
      epochNumber,
      sequenceNumber: userSeq,
      senderType: 'user',
      senderId,
      parentMessageId,
    });

    const assistantResults = await persistAllAssistants(
      tx as unknown as Database,
      assistantMsgs,
      sequences,
      {
        conversationId,
        epochPublicKey,
        epochNumber,
        userMessageId,
        userId,
        ...(groupBillingContext !== undefined && { groupBillingContext }),
      }
    );

    if (forkId) {
      const lastAssistant = assistantMsgs.at(-1);
      if (!lastAssistant) throw new Error('invariant: assistantMsgs must not be empty');
      await updateForkTip(tx as unknown as Database, forkId, lastAssistant.id);
    }

    const firstResult = assistantResults[0];
    if (!firstResult) throw new Error('invariant: assistantResults must not be empty');

    return {
      userSequence: userSeq,
      aiSequence: firstResult.aiSequence,
      epochNumber,
      cost: firstResult.cost,
      usageRecordId: firstResult.usageRecordId,
      userEnvelope: {
        messageId: userMessageId,
        wrappedContentKey: userPersisted.wrappedContentKey,
        contentItem: userPersisted.contentItem,
      },
      assistantResults,
    };
  });
}
