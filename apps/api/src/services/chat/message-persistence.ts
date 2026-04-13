import { type Database } from '@hushbox/db';
import {
  assignSequenceNumbers,
  fetchEpochPublicKey,
  insertEnvelopeTextMessage,
  type InsertedTextContentItem,
  chargeAndTrackUsage,
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

export interface PersistedEnvelope {
  messageId: string;
  wrappedContentKey: Uint8Array;
  contentItem: InsertedTextContentItem;
}

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

export interface AssistantMessageInput {
  id: string;
  content: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

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

  for (const msg of assistantMsgs) {
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

    const assistantResults: AssistantResult[] = [];

    for (const [index, assistantMsg] of assistantMsgs.entries()) {
      const msg = assistantMsg;
      const aiSeq = sequences[1 + index];
      if (aiSeq === undefined)
        throw new Error(`invariant: expected sequence number at index ${String(1 + index)}`);
      const costAmount = msg.cost.toFixed(8);

      const persisted = await insertEnvelopeTextMessage(tx as unknown as Database, {
        id: msg.id,
        conversationId,
        textContent: msg.content,
        epochPublicKey,
        epochNumber,
        sequenceNumber: aiSeq,
        senderType: 'ai',
        modelName: msg.model,
        cost: costAmount,
        parentMessageId: userMessageId,
      });

      const { usageRecordId } = await chargeAndTrackUsage(tx as unknown as Database, {
        userId,
        cost: costAmount,
        model: msg.model,
        assistantMessageId: msg.id,
        conversationId,
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        ...(msg.cachedTokens !== undefined && { cachedTokens: msg.cachedTokens }),
        ...(groupBillingContext !== undefined && { groupBillingContext }),
      });

      assistantResults.push({
        assistantMessageId: msg.id,
        model: msg.model,
        aiSequence: aiSeq,
        cost: costAmount,
        usageRecordId,
        envelope: {
          messageId: msg.id,
          wrappedContentKey: persisted.wrappedContentKey,
          contentItem: persisted.contentItem,
        },
      });
    }

    if (forkId) {
      const lastAssistant = assistantMsgs.at(-1);
      if (!lastAssistant) throw new Error('invariant: assistantMsgs must not be empty');
      const lastAssistantId = lastAssistant.id;
      await updateForkTip(tx as unknown as Database, forkId, lastAssistantId);
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
