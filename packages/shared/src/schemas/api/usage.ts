import { z } from 'zod';

/** Valid granularity options for time-series aggregation */
export const usageGranularitySchema = z.enum(['day', 'week']);

export type UsageGranularity = z.infer<typeof usageGranularitySchema>;

/**
 * Shared query schema for date-range-filtered usage endpoints.
 * startDate and endDate are ISO 8601 date strings (YYYY-MM-DD).
 */
export const usageDateRangeQuerySchema = z.object({
  startDate: z.iso.date('startDate must be a valid date (YYYY-MM-DD)'),
  endDate: z.iso.date('endDate must be a valid date (YYYY-MM-DD)'),
});

export type UsageDateRangeQuery = z.infer<typeof usageDateRangeQuerySchema>;

/**
 * Query schema for time-series endpoints that support granularity.
 */
export const usageTimeSeriesQuerySchema = usageDateRangeQuerySchema.extend({
  granularity: usageGranularitySchema.optional().default('day'),
  model: z.string().optional(),
});

export type UsageTimeSeriesQuery = z.infer<typeof usageTimeSeriesQuerySchema>;

/**
 * Query schema for spending-by-conversation endpoint.
 */
export const usageConversationQuerySchema = usageDateRangeQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

export type UsageConversationQuery = z.infer<typeof usageConversationQuerySchema>;

/**
 * Response schema for GET /usage/summary.
 * KPI card data: totals for the selected date range.
 */
export const usageSummaryResponseSchema = z.object({
  totalSpent: z.string(),
  messageCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCachedTokens: z.number(),
});

export type UsageSummaryResponse = z.infer<typeof usageSummaryResponseSchema>;

/**
 * A single data point for spending-over-time chart.
 */
export const spendingOverTimePointSchema = z.object({
  period: z.string(),
  model: z.string(),
  totalCost: z.string(),
  count: z.number(),
});

/**
 * Response schema for GET /usage/spending-over-time.
 */
export const spendingOverTimeResponseSchema = z.object({
  data: z.array(spendingOverTimePointSchema),
});

export type SpendingOverTimeResponse = z.infer<typeof spendingOverTimeResponseSchema>;

/**
 * A single row in the cost-by-model breakdown.
 */
export const costByModelRowSchema = z.object({
  model: z.string(),
  provider: z.string(),
  totalCost: z.string(),
  messageCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
});

/**
 * Response schema for GET /usage/cost-by-model.
 */
export const costByModelResponseSchema = z.object({
  data: z.array(costByModelRowSchema),
});

export type CostByModelResponse = z.infer<typeof costByModelResponseSchema>;

/**
 * A single row in the spending-by-conversation breakdown. `messageCount` counts
 * billed replies the way the usage summary does; `modelIds` are those replies'
 * generating models, highest spend first.
 */
export const spendingByConversationRowSchema = z.object({
  conversationId: z.string(),
  totalSpent: z.string(),
  messageCount: z.number(),
  modelIds: z.array(z.string()),
});

/**
 * Response schema for GET /usage/spending-by-conversation.
 */
export const spendingByConversationResponseSchema = z.object({
  data: z.array(spendingByConversationRowSchema),
});

export type SpendingByConversationResponse = z.infer<typeof spendingByConversationResponseSchema>;

/**
 * Response schema for GET /usage/models.
 * Returns distinct model names the user has used.
 */
export const usageModelsResponseSchema = z.object({
  models: z.array(z.string()).readonly(),
});

export type UsageModelsResponse = z.infer<typeof usageModelsResponseSchema>;
