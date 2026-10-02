import { asc, eq, inArray } from 'drizzle-orm';
import { contentItems, llmCompletions, usageRecords } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import type { ResolvedReasoningEffort } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ContentItemRow } from '../ports/stores.js';

/**
 * Content items for a set of message ids, grouped by message and ordered by
 * position. Shared by the history read and the public-share read so the
 * `content_items` projection lives in exactly one place.
 */
export function contentItemsByMessage(
  db: DbWriter,
  messageIds: readonly string[]
): ResultAsync<Map<string, ContentItemRow[]>, DomainError> {
  if (messageIds.length === 0) return okAsync(new Map<string, ContentItemRow[]>());
  return fromPromise(
    db
      .select({
        id: contentItems.id,
        messageId: contentItems.messageId,
        position: contentItems.position,
        contentType: contentItems.contentType,
        mimeType: contentItems.mimeType,
        sizeBytes: contentItems.sizeBytes,
        width: contentItems.width,
        height: contentItems.height,
        durationMs: contentItems.durationMs,
        encryptedBlob: contentItems.encryptedBlob,
        costNanoUsd: contentItems.costNanoUsd,
        modelId: contentItems.modelId,
        isSmartModel: contentItems.isSmartModel,
      })
      .from(contentItems)
      .where(inArray(contentItems.messageId, [...messageIds]))
      .orderBy(asc(contentItems.position), asc(contentItems.id)),
    storeFailure
  ).andThen((rows) =>
    generationFactsByContentItem(
      db,
      rows.map((row) => row.id)
    ).map((factsByItem) => {
      const byMessage = new Map<string, ContentItemRow[]>();
      for (const row of rows) {
        const list = byMessage.get(row.messageId) ?? [];
        list.push({ ...row, ...(factsByItem.get(row.id) ?? NO_GENERATION_FACTS) });
        byMessage.set(row.messageId, list);
      }
      return byMessage;
    })
  );
}

/** What one content item's completion rows contribute to the history read. */
interface ItemGenerationFacts {
  readonly reasoningTokens: number;
  readonly reasoningEffort: ResolvedReasoningEffort | null;
  readonly reasoningDurationMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** An item with no completion row (user text, media) carries every fact as null. */
const NO_GENERATION_FACTS = {
  reasoningTokens: null,
  reasoningEffort: null,
  reasoningDurationMs: null,
  inputTokens: null,
  outputTokens: null,
} as const satisfies Record<keyof ItemGenerationFacts, null>;

/**
 * The persisted generation facts per content item, over the billed generations
 * anchored to it (`usage_records` → `llm_completions`, both billing-owned,
 * read-only here exactly like `content_items`). One query serves every fact:
 * they live on the same row, and the message list must never read a row twice.
 * An item with no completion row (user text, media) is absent from the map.
 *
 * The facts aggregate differently and the difference is load-bearing:
 *
 * - Tokens — reasoning, input and output alike — are a spend, so they SUM. A
 *   multi-step generation records one completion row per step under the same
 *   anchor, and an auxiliary charge (a classifier's) anchors to the same item,
 *   as its cost does; the item's count is their total.
 * - The level is a decision taken once for the whole generation, so it is
 *   TAKEN, never folded. Every step of one generation records the same level,
 *   while an auxiliary charge anchored to the same item (a classifier's)
 *   records none — so the level is the one non-null row's, and null survives
 *   only when no row recorded a level at all. A `null` here means no reasoning
 *   wire was sent; `off` means reasoning was resolved to none.
 * - The reasoning time SUMS over the rows that recorded one, like the tokens,
 *   and stays null only when no row did: a classifier's row records none, and
 *   neither does a row settled before the time was measured.
 */
function generationFactsByContentItem(
  db: DbWriter,
  contentItemIds: readonly string[]
): ResultAsync<Map<string, ItemGenerationFacts>, DomainError> {
  if (contentItemIds.length === 0) return okAsync(new Map<string, ItemGenerationFacts>());
  return fromPromise(
    db
      .select({
        contentItemId: usageRecords.contentItemId,
        reasoningTokens: llmCompletions.reasoningTokens,
        reasoningEffort: llmCompletions.reasoningEffort,
        reasoningDurationMs: llmCompletions.reasoningDurationMs,
        inputTokens: llmCompletions.inputTokens,
        outputTokens: llmCompletions.outputTokens,
      })
      .from(usageRecords)
      .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
      .where(inArray(usageRecords.contentItemId, [...contentItemIds])),
    storeFailure
  ).map((rows) => {
    const byItem = new Map<string, ItemGenerationFacts>();
    for (const row of rows) {
      /* v8 ignore next -- unreachable: SQL `IN` never matches NULL, so the anchor-less usage records this narrowing satisfies the nullable column for are already excluded by the where clause */
      if (row.contentItemId === null) continue;
      byItem.set(row.contentItemId, foldCompletion(byItem.get(row.contentItemId), row));
    }
    return byItem;
  });
}

/** One completion row folded into its item's facts, by the rules on {@link generationFactsByContentItem}. */
function foldCompletion(
  prior: ItemGenerationFacts | undefined,
  row: ItemGenerationFacts
): ItemGenerationFacts {
  if (prior === undefined) {
    return {
      reasoningTokens: row.reasoningTokens,
      reasoningEffort: row.reasoningEffort,
      reasoningDurationMs: row.reasoningDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    };
  }
  return {
    reasoningTokens: prior.reasoningTokens + row.reasoningTokens,
    reasoningEffort: prior.reasoningEffort ?? row.reasoningEffort,
    reasoningDurationMs: sumRecorded(prior.reasoningDurationMs, row.reasoningDurationMs),
    inputTokens: prior.inputTokens + row.inputTokens,
    outputTokens: prior.outputTokens + row.outputTokens,
  };
}

/** The sum of two recorded figures, null only when neither was recorded. */
function sumRecorded(prior: number | null, next: number | null): number | null {
  if (prior === null) return next;
  if (next === null) return prior;
  return prior + next;
}
