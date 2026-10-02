import { describe, it, expect } from 'vitest';
import {
  usageGranularitySchema,
  usageDateRangeQuerySchema,
  usageTimeSeriesQuerySchema,
  usageConversationQuerySchema,
  usageSummaryResponseSchema,
  spendingOverTimeResponseSchema,
  costByModelResponseSchema,
  spendingByConversationResponseSchema,
  spendingByConversationRowSchema,
  usageModelsResponseSchema,
} from './usage.ts';

describe('usageGranularitySchema', () => {
  it('accepts "day"', () => {
    expect(usageGranularitySchema.parse('day')).toBe('day');
  });

  it('accepts "week"', () => {
    expect(usageGranularitySchema.parse('week')).toBe('week');
  });

  it('rejects invalid granularity', () => {
    expect(() => usageGranularitySchema.parse('month')).toThrow();
  });
});

describe('usageDateRangeQuerySchema', () => {
  it('accepts valid date range', () => {
    const result = usageDateRangeQuerySchema.parse({
      startDate: '2026-01-01',
      endDate: '2026-03-27',
    });
    expect(result.startDate).toBe('2026-01-01');
    expect(result.endDate).toBe('2026-03-27');
  });

  it('rejects missing startDate', () => {
    expect(() => usageDateRangeQuerySchema.parse({ endDate: '2026-03-27' })).toThrow();
  });

  it('rejects invalid date format', () => {
    expect(() =>
      usageDateRangeQuerySchema.parse({
        startDate: 'not-a-date',
        endDate: '2026-03-27',
      })
    ).toThrow();
  });
});

describe('usageTimeSeriesQuerySchema', () => {
  it('accepts date range with defaults', () => {
    const result = usageTimeSeriesQuerySchema.parse({
      startDate: '2026-01-01',
      endDate: '2026-03-27',
    });
    expect(result.granularity).toBe('day');
    expect(result.model).toBeUndefined();
  });

  it('accepts explicit granularity and model', () => {
    const result = usageTimeSeriesQuerySchema.parse({
      startDate: '2026-01-01',
      endDate: '2026-03-27',
      granularity: 'week',
      model: 'anthropic/claude-opus-4.6',
    });
    expect(result.granularity).toBe('week');
    expect(result.model).toBe('anthropic/claude-opus-4.6');
  });
});

describe('usageConversationQuerySchema', () => {
  it('defaults limit to 5', () => {
    const result = usageConversationQuerySchema.parse({
      startDate: '2026-01-01',
      endDate: '2026-03-27',
    });
    expect(result.limit).toBe(5);
  });

  it('accepts custom limit', () => {
    const result = usageConversationQuerySchema.parse({
      startDate: '2026-01-01',
      endDate: '2026-03-27',
      limit: 10,
    });
    expect(result.limit).toBe(10);
  });

  it('rejects limit above 20', () => {
    expect(() =>
      usageConversationQuerySchema.parse({
        startDate: '2026-01-01',
        endDate: '2026-03-27',
        limit: 25,
      })
    ).toThrow();
  });
});

describe('usageSummaryResponseSchema', () => {
  it('accepts valid summary data', () => {
    const result = usageSummaryResponseSchema.parse({
      totalSpent: '12.47000000',
      messageCount: 342,
      totalInputTokens: 500_000,
      totalOutputTokens: 700_000,
      totalCachedTokens: 50_000,
    });
    expect(result.totalSpent).toBe('12.47000000');
    expect(result.messageCount).toBe(342);
  });

  it('rejects missing fields', () => {
    expect(() => usageSummaryResponseSchema.parse({ totalSpent: '0' })).toThrow();
  });
});

describe('spendingOverTimeResponseSchema', () => {
  it('accepts valid data array', () => {
    const result = spendingOverTimeResponseSchema.parse({
      data: [
        { period: '2026-01-01', model: 'gpt-4o', totalCost: '1.50', count: 10 },
        { period: '2026-01-02', model: 'claude-opus', totalCost: '2.00', count: 5 },
      ],
    });
    expect(result.data).toHaveLength(2);
  });

  it('accepts empty data array', () => {
    const result = spendingOverTimeResponseSchema.parse({ data: [] });
    expect(result.data).toHaveLength(0);
  });
});

describe('costByModelResponseSchema', () => {
  it('accepts valid model breakdown', () => {
    const result = costByModelResponseSchema.parse({
      data: [
        {
          model: 'gpt-4o',
          provider: 'openai',
          totalCost: '5.00',
          messageCount: 100,
          totalInputTokens: 200_000,
          totalOutputTokens: 300_000,
        },
      ],
    });
    expect(result.data[0]?.model).toBe('gpt-4o');
  });
});

describe('spendingByConversationResponseSchema', () => {
  it('accepts valid conversation data', () => {
    const result = spendingByConversationResponseSchema.parse({
      data: [
        { conversationId: 'conv-1', totalSpent: '3500', messageCount: 2, modelIds: ['m-a'] },
        { conversationId: 'conv-2', totalSpent: '1200', messageCount: 1, modelIds: [] },
      ],
    });
    expect(result.data).toHaveLength(2);
  });

  it('rejects a row without its message count', () => {
    const result = spendingByConversationResponseSchema.safeParse({
      data: [{ conversationId: 'conv-1', totalSpent: '3500', modelIds: ['m-a'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a row without its model ids', () => {
    const result = spendingByConversationResponseSchema.safeParse({
      data: [{ conversationId: 'conv-1', totalSpent: '3500', messageCount: 2 }],
    });
    expect(result.success).toBe(false);
  });

  it('declares exactly the row fields the per-conversation read serializes', () => {
    expect(
      Object.keys(spendingByConversationRowSchema.shape).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['conversationId', 'messageCount', 'modelIds', 'totalSpent']);
  });
});

describe('usageModelsResponseSchema', () => {
  it('accepts valid models list', () => {
    const result = usageModelsResponseSchema.parse({
      models: ['gpt-4o', 'claude-opus', 'gemini-pro'],
    });
    expect(result.models).toHaveLength(3);
  });

  it('accepts empty models list', () => {
    const result = usageModelsResponseSchema.parse({ models: [] });
    expect(result.models).toHaveLength(0);
  });
});
