import { z } from 'zod';
import {
  messageResponseSchema,
  nanoUSD,
  serializeNanoUSD,
  toBase64,
  trimPage,
} from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveCallerMember } from '../shares/caller.js';
import { contentItemView } from './content-item-view.js';
import type { HistoryContentItemResponse, MessageResponse } from '@hushbox/shared';
import type { ConversationCaller } from '../shares/caller.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ContentItemRow, ConversationsStores, HistoryMessageRow } from '../../ports/index.js';
import type { Outcome } from '../outcomes.js';

/**
 * The history read's content item: the shared `ContentItemResponse` plus the
 * settled display metadata. Declared in `@hushbox/shared`; this annotation is
 * what makes a field rename there a compile error here.
 */
type HistoryContentItemView = HistoryContentItemResponse;

/**
 * `servesCost` is false for a link guest: what a turn cost is the payer's
 * business, so a guest reads the model and never the billed amount — nor the
 * input and output token counts, which times the model's public rates rebuild it.
 */
function historyContentItemView(row: ContentItemRow, servesCost: boolean): HistoryContentItemView {
  return {
    ...contentItemView(row),
    modelName: row.modelId,
    cost:
      !servesCost || row.costNanoUsd === null ? null : serializeNanoUSD(nanoUSD(row.costNanoUsd)),
    inputTokens: servesCost ? row.inputTokens : null,
    outputTokens: servesCost ? row.outputTokens : null,
    isSmartModel: row.isSmartModel,
    reasoningTokens: row.reasoningTokens,
    reasoningEffort: row.reasoningEffort,
    reasoningDurationMs: row.reasoningDurationMs,
  };
}

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

/** The history read's message, declared in `@hushbox/shared` like {@link HistoryContentItemView}. */
type HistoryMessage = MessageResponse;

const messageHistorySchema = z.object({
  messages: z.array(messageResponseSchema),
  /** The next page's cursor (the last sequence number), or null at the end. */
  nextCursor: z.string().nullable(),
});

type MessageHistoryView = z.infer<typeof messageHistorySchema>;

/**
 * A page of the caller's conversation history, from their `visibleFromEpoch`
 * forward — the path a second device, a reload, a newly-added member, or a
 * shared-link guest has to load prior messages. Guest-reachable, so it takes a
 * resolved `ConversationCaller` (user OR link guest) and gates through the
 * shared `resolveCallerMember` active-member check — a revoked guest (its row
 * left) or a non-member gets the indistinguishable not-found. The caller's own
 * member row supplies the `visibleFromEpoch` floor, so a rotation-seated guest
 * (or a late-joining member) never sees an earlier epoch's messages. Messages
 * page by `sequenceNumber` (the cursor); content items order by `position`
 * within each message.
 */
export function getMessageHistory(
  stores: ConversationsStores,
  params: {
    readonly conversationId: string;
    readonly caller: ConversationCaller;
    readonly cursor?: number;
    readonly limit?: number;
  }
): ResultAsync<Outcome<MessageHistoryView>, DomainError> {
  const limit = Math.min(params.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
    if (caller === null) return okAsync<Outcome<MessageHistoryView>>({ refusal: 'not-found' });
    return stores.messages
      .history({
        conversationId: params.conversationId,
        minEpoch: caller.visibleFromEpoch,
        afterSequence: params.cursor ?? null,
        // Over-fetch one to detect a further page without a second query.
        limit: limit + 1,
      })
      .map((rows): Outcome<MessageHistoryView> => {
        const { page, hasMore } = trimPage(rows, limit);
        const last = page.at(-1);
        // Validated where it is built: the schema is this page's runtime
        // invariant, and a shape it does not declare is a server defect
        // (a throw), never a refusal the client could act on.
        // Page size does not price this parse: its cost is O(fields), not
        // O(bytes) — `z.string()` is a `typeof` check that never reads the
        // string, so the ciphertext that is nearly every byte of a page
        // validates for free.
        return messageHistorySchema.parse({
          messages: page.map((row) => historyMessageView(row, params.caller.kind === 'user')),
          nextCursor: hasMore && last !== undefined ? String(last.sequenceNumber) : null,
        });
      });
  });
}

/**
 * `parentMessageId` is copied out unfiltered: the floor selects which rows the page
 * contains, not which ids those rows carry, so every row whose parent sits below
 * the caller's floor names it. That identifier reaches nothing — the floor is
 * enforced at this read and at share and presign authorization — and nulling it
 * would break client threading for no gain.
 */
function historyMessageView(row: HistoryMessageRow, servesCost: boolean): HistoryMessage {
  return {
    id: row.id,
    parentMessageId: row.parentMessageId,
    sequenceNumber: row.sequenceNumber,
    epochNumber: row.epochNumber,
    senderType: row.senderType,
    senderId: row.senderId,
    wrappedContentKey: toBase64(row.wrappedContentKey),
    batchId: row.batchId,
    deleted: row.deletedAt !== null,
    createdAt: row.createdAt.toISOString(),
    contentItems: row.contentItems.map((item) => historyContentItemView(item, servesCost)),
  };
}
