import { and, asc, desc, eq, gt, gte, isNotNull, lte, sql } from 'drizzle-orm';
import {
  contentItems,
  ledgerEntries,
  llmCompletions,
  mediaGenerations,
  usageRecords,
} from '@hushbox/db';
import { providerOfModelId } from '@hushbox/shared';
import { fromPromise } from '../../../lib/result/index.js';
import { requireRow, storeFailure } from './store-failure.js';
import type { Database } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type {
  BillingStores,
  LlmCompletionInput,
  MediaGenerationInput,
  UsageDateRangeQuery,
  UsageGranularity,
  UsageRecordInput,
} from '../ports/index.js';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * A `date_trunc` bucket expression, rendered as text for stable grouping. The
 * granularity is a closed `'day' | 'week'` union (Zod-validated at the route),
 * never client-freeform, so interpolating it as raw SQL cannot inject.
 */
function truncatedPeriod(granularity: UsageGranularity, column: PgColumn): SQL<string> {
  return sql<string>`date_trunc('${sql.raw(granularity)}', ${column})::text`;
}

/** `coalesce(sum(col), 0)` as an integer — one 0-defaulted token aggregate. */
function sumInt(column: PgColumn): SQL<number> {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}

/** The three token aggregates shared by the token-bearing usage reads. */
function tokenSums(): {
  readonly inputTokens: SQL<number>;
  readonly outputTokens: SQL<number>;
  readonly cachedTokens: SQL<number>;
} {
  return {
    inputTokens: sumInt(llmCompletions.inputTokens),
    outputTokens: sumInt(llmCompletions.outputTokens),
    cachedTokens: sumInt(llmCompletions.cachedInputTokens),
  };
}

/** `sum(cost_nano_usd)` as a bigint — the spend aggregate over usage records. */
function sumCost(): SQL<bigint> {
  return sql<bigint>`sum(${usageRecords.costNanoUsd})`.mapWith(BigInt);
}

/**
 * The billed replies among the aggregated usage records: distinct anchoring
 * content items, so a reply billed in several generations (an Auto turn's
 * classifier and answer, a multi-step answer) counts once.
 */
function replyCount(): SQL<number> {
  return sql<number>`count(distinct ${usageRecords.contentItemId})`.mapWith(Number);
}

/**
 * The caller-scoped usage-record window shared by the analytics aggregations:
 * the caller as PAYER (the sole visibility boundary) AND the inclusive
 * `createdAt` range, optionally narrowed to one model id. Payer-scoped is what
 * makes these figures reconcile with the ledger reads beside them on the same
 * surface — a spend total and its wallet legs must count the same charges.
 */
function usageWindow(range: UsageDateRangeQuery, modelId?: string): SQL | undefined {
  const conditions = [
    eq(usageRecords.payerUserId, range.userId),
    gte(usageRecords.createdAt, range.start),
    lte(usageRecords.createdAt, range.end),
  ];
  if (modelId !== undefined) conditions.push(eq(usageRecords.modelId, modelId));
  return and(...conditions);
}

/**
 * The usage part of the slice's repository: the settlement-time usage-record
 * and dimension writes, and the payer-scoped analytics reads over them.
 */
export function createUsageStores(): Pick<
  BillingStores,
  | 'insertUsageRecordIfAbsentWithinTx'
  | 'insertLlmCompletionWithinTx'
  | 'insertMediaGenerationWithinTx'
  | 'readUsageRecord'
  | 'aggregateUsageByModel'
  | 'readUsageChargeWallet'
  | 'stampRunConversationWithinTx'
  | 'summarizeUsage'
  | 'usageSpendingOverTime'
  | 'usageCostByModel'
  | 'usageSpendingByConversation'
  | 'distinctUsageModels'
> {
  return {
    async insertUsageRecordIfAbsentWithinTx(tx: SettlementTx, input: UsageRecordInput) {
      const inserted = await tx
        .insert(usageRecords)
        .values({
          payerUserId: input.payerUserId,
          ...(input.senderUserId === undefined ? {} : { senderUserId: input.senderUserId }),
          ...(input.senderLinkId === undefined ? {} : { senderLinkId: input.senderLinkId }),
          contentItemId: input.contentItemId,
          runId: input.runId,
          modelId: input.modelId,
          providerName: input.providerName,
          modality: input.modality,
          ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
          costNanoUsd: input.costNanoUsd,
          isEstimated: input.isEstimated,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: usageRecords.idempotencyKey })
        .returning({ id: usageRecords.id });
      const created = inserted[0];
      if (created !== undefined) return { id: created.id, created: true };
      const existing = await tx
        .select({ id: usageRecords.id })
        .from(usageRecords)
        .where(eq(usageRecords.idempotencyKey, input.idempotencyKey));
      return {
        id: requireRow(existing[0], 'usage record insert conflicted but no row exists').id,
        created: false,
      };
    },

    async insertLlmCompletionWithinTx(tx: SettlementTx, input: LlmCompletionInput) {
      await tx.insert(llmCompletions).values({
        usageRecordId: input.usageRecordId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        reasoningTokens: input.reasoningTokens,
        cachedInputTokens: input.cachedInputTokens,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.reasoningDurationMs === undefined
          ? {}
          : { reasoningDurationMs: input.reasoningDurationMs }),
      });
    },

    async insertMediaGenerationWithinTx(tx: SettlementTx, input: MediaGenerationInput) {
      await tx.insert(mediaGenerations).values({
        usageRecordId: input.usageRecordId,
        modality: input.modality,
        ...(input.imageCount === undefined ? {} : { imageCount: input.imageCount }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
      });
    },

    readUsageRecord(db: Database, id: string) {
      return fromPromise(
        db
          .select({
            id: usageRecords.id,
            payerUserId: usageRecords.payerUserId,
            contentItemId: usageRecords.contentItemId,
            runId: usageRecords.runId,
            modality: usageRecords.modality,
            generationId: usageRecords.generationId,
            costNanoUsd: usageRecords.costNanoUsd,
            isEstimated: usageRecords.isEstimated,
            idempotencyKey: usageRecords.idempotencyKey,
          })
          .from(usageRecords)
          .where(eq(usageRecords.id, id)),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },

    aggregateUsageByModel(db: Database, query) {
      // userId stays a permanent conjunct — the sole visibility boundary — so
      // the cursor can never widen the scope across users.
      const conditions = [eq(usageRecords.payerUserId, query.userId)];
      if (query.cursor !== undefined) {
        conditions.push(gt(usageRecords.modelId, query.cursor));
      }
      return fromPromise(
        db
          .select({
            modelId: usageRecords.modelId,
            // Money stays bigint — never Number()-coerced.
            totalNanoUsd: sql<bigint>`sum(${usageRecords.costNanoUsd})`.mapWith(BigInt),
            recordCount: sql<number>`count(*)`.mapWith(Number),
            estimatedCount:
              sql<number>`count(*) filter (where ${usageRecords.isEstimated})`.mapWith(Number),
          })
          .from(usageRecords)
          .where(and(...conditions))
          .groupBy(usageRecords.modelId)
          .orderBy(usageRecords.modelId)
          .limit(query.limit),
        storeFailure
      );
    },

    readUsageChargeWallet(db: Database, usageRecordId: string) {
      return fromPromise(
        db
          .select({ walletId: ledgerEntries.walletId })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.usageRecordId, usageRecordId),
              eq(ledgerEntries.kind, 'charge'),
              isNotNull(ledgerEntries.walletId)
            )
          ),
        storeFailure
      ).map((rows) => rows[0]?.walletId ?? null);
    },

    async stampRunConversationWithinTx(tx, runId, conversationId) {
      await tx.update(usageRecords).set({ conversationId }).where(eq(usageRecords.runId, runId));
    },

    summarizeUsage(db, range) {
      // Spend and the reply count cover every charge in the window, any
      // modality, so they equal the per-conversation rows summed; the LEFT JOIN
      // leaves the token sums to language generations, the only rows with a
      // token dimension.
      return fromPromise(
        db
          .select({
            totalNanoUsd: sql<bigint>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`.mapWith(
              BigInt
            ),
            messageCount: replyCount(),
            ...tokenSums(),
          })
          .from(usageRecords)
          .leftJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(range)),
        storeFailure
      ).map(
        (rows) =>
          rows[0] ?? {
            totalNanoUsd: 0n,
            messageCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
          }
      );
    },

    usageSpendingOverTime(db, args) {
      const period = truncatedPeriod(args.granularity, usageRecords.createdAt);
      return fromPromise(
        db
          .select({
            period,
            modelId: usageRecords.modelId,
            totalNanoUsd: sumCost(),
            count: sql<number>`count(*)`.mapWith(Number),
          })
          .from(usageRecords)
          .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(args, args.modelId))
          .groupBy(period, usageRecords.modelId)
          .orderBy(asc(period)),
        storeFailure
      );
    },

    usageCostByModel(db, range) {
      // Grouped by model alone: a record's provider is the endpoint that served
      // it (the model's author on older rows), so grouping by it would split one
      // model into several rows.
      return fromPromise(
        db
          .select({
            modelId: usageRecords.modelId,
            totalNanoUsd: sumCost(),
            messageCount: sql<number>`count(*)`.mapWith(Number),
            inputTokens: sumInt(llmCompletions.inputTokens),
            outputTokens: sumInt(llmCompletions.outputTokens),
          })
          .from(usageRecords)
          .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(range))
          .groupBy(usageRecords.modelId)
          .orderBy(desc(sql`sum(${usageRecords.costNanoUsd})`)),
        storeFailure
      ).map((rows) =>
        rows.map((row) => ({ ...row, providerName: providerOfModelId(row.modelId) }))
      );
    },

    usageSpendingByConversation(db, args) {
      // Grouped first per (conversation, reply model): a reply's generations
      // all bill under its content item's model, so a classifier's engine never
      // surfaces as a model, and the per-model reply counts sum to the
      // conversation's distinct replies because each reply has one model.
      const perModel = db
        .select({
          conversationId: sql<string>`${usageRecords.conversationId}`.as('conversation_id'),
          modelId: sql<string | null>`${contentItems.modelId}`.as('model_id'),
          spend: sql<bigint>`sum(${usageRecords.costNanoUsd})`.as('spend'),
          replies: replyCount().as('replies'),
        })
        .from(usageRecords)
        .leftJoin(contentItems, eq(contentItems.id, usageRecords.contentItemId))
        .where(and(usageWindow(args), isNotNull(usageRecords.conversationId)))
        .groupBy(usageRecords.conversationId, contentItems.modelId)
        .as('per_model');
      return fromPromise(
        db
          .select({
            conversationId: perModel.conversationId,
            totalNanoUsd: sql<bigint>`sum(${perModel.spend})`.mapWith(BigInt),
            messageCount: sql<number>`sum(${perModel.replies})`.mapWith(Number),
            modelIds: sql<
              string[]
            >`coalesce(array_agg(${perModel.modelId} order by ${perModel.spend} desc, ${perModel.modelId}) filter (where ${perModel.modelId} is not null), '{}')`,
          })
          .from(perModel)
          .groupBy(perModel.conversationId)
          .orderBy(desc(sql`sum(${perModel.spend})`))
          .limit(args.limit),
        storeFailure
      );
    },

    distinctUsageModels(db, userId) {
      return fromPromise(
        db
          .selectDistinct({ modelId: usageRecords.modelId })
          .from(usageRecords)
          .where(eq(usageRecords.payerUserId, userId))
          .orderBy(asc(usageRecords.modelId)),
        storeFailure
      ).map((rows) => rows.map((row) => row.modelId));
    },
  };
}
