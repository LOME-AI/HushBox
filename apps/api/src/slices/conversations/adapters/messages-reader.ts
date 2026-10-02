import { and, asc, desc, eq, gt, gte, isNotNull } from 'drizzle-orm';
import { contentItems, messages } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import { contentItemsByMessage } from './content-item-reads.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { MessagesReader, HistoryMessageRow, MessageHeader } from '../ports/stores.js';

export function createMessagesReader(db: DbWriter): MessagesReader {
  return {
    inConversation: (messageId, conversationId) =>
      selectMessageHeader(db, messageId, conversationId).map((header) => header !== null),

    headerInConversation: (messageId, conversationId) =>
      selectMessageHeader(db, messageId, conversationId),

    latestId: (conversationId) =>
      fromPromise(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(desc(messages.sequenceNumber))
          .limit(1),
        storeFailure
      ).map((rows) => rows[0]?.id ?? null),

    parentChainRows: (conversationId) =>
      fromPromise(
        db
          .select({ id: messages.id, parentMessageId: messages.parentMessageId })
          .from(messages)
          .where(eq(messages.conversationId, conversationId)),
        storeFailure
      ),

    senderChainRows: (conversationId) =>
      fromPromise(
        db
          .select({
            id: messages.id,
            parentMessageId: messages.parentMessageId,
            senderType: messages.senderType,
            senderId: messages.senderId,
            sequenceNumber: messages.sequenceNumber,
          })
          .from(messages)
          .where(eq(messages.conversationId, conversationId)),
        storeFailure
      ),

    assistantReplyModels: (params) =>
      fromPromise(
        db
          .selectDistinct({ messageId: messages.id, modelId: contentItems.modelId })
          .from(messages)
          .innerJoin(contentItems, eq(contentItems.messageId, messages.id))
          .where(
            and(
              eq(messages.conversationId, params.conversationId),
              eq(messages.parentMessageId, params.parentMessageId),
              eq(messages.senderType, 'assistant'),
              isNotNull(contentItems.modelId)
            )
          ),
        storeFailure
      ).map((rows) =>
        rows.flatMap((row) => {
          /* v8 ignore next -- unreachable: `isNotNull(contentItems.modelId)` excludes null rows, and it narrows the rows rather than the column type, so the null arm is dropped here rather than asserted away */
          if (row.modelId === null) return [];
          return [{ messageId: row.messageId, modelId: row.modelId }];
        })
      ),

    history: (params) => selectMessageHistory(db, params),
  };
}

/**
 * The message's epoch and sender when it belongs to the conversation, null
 * otherwise. `inConversation` is this read's existence projection, so the two
 * can never disagree about which messages belong to a conversation.
 */
function selectMessageHeader(
  db: DbWriter,
  messageId: string,
  conversationId: string
): ResultAsync<MessageHeader | null, DomainError> {
  return fromPromise(
    db
      .select({
        epochNumber: messages.epochNumber,
        senderType: messages.senderType,
        senderId: messages.senderId,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId))),
    storeFailure
  ).map((rows) => rows[0] ?? null);
}

/** A page of message history with content items attached per message. */
function selectMessageHistory(
  db: DbWriter,
  params: {
    readonly conversationId: string;
    readonly minEpoch: number;
    readonly afterSequence: number | null;
    readonly limit: number;
  }
): ResultAsync<HistoryMessageRow[], DomainError> {
  return fromPromise(
    db
      .select({
        id: messages.id,
        parentMessageId: messages.parentMessageId,
        sequenceNumber: messages.sequenceNumber,
        epochNumber: messages.epochNumber,
        senderType: messages.senderType,
        senderId: messages.senderId,
        wrappedContentKey: messages.wrappedContentKey,
        batchId: messages.batchId,
        deletedAt: messages.deletedAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, params.conversationId),
          gte(messages.epochNumber, params.minEpoch),
          params.afterSequence === null
            ? undefined
            : gt(messages.sequenceNumber, params.afterSequence)
        )
      )
      .orderBy(asc(messages.sequenceNumber))
      .limit(params.limit),
    storeFailure
  ).andThen((rows) =>
    contentItemsByMessage(
      db,
      rows.map((row) => row.id)
    ).map((byMessage) => rows.map((row) => ({ ...row, contentItems: byMessage.get(row.id) ?? [] })))
  );
}
