import { describe, it, expect } from 'vitest';
import {
  usageGranularitySchema,
  usageDateRangeQuerySchema,
  usageTimeSeriesQuerySchema,
  usageConversationQuerySchema,
  usageBalanceHistoryQuerySchema,
  usageSummaryResponseSchema,
  spendingOverTimeResponseSchema,
  costByModelResponseSchema,
  tokenUsageOverTimeResponseSchema,
  spendingByConversationResponseSchema,
  balanceHistoryResponseSchema,
  usageModelsResponseSchema,
} from './usage.js';

// ============================================================
// usageGranularitySchema
// ============================================================

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

// ============================================================
// usageDateRangeQuerySchema
// ============================================================

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

// ============================================================
// usageTimeSeriesQuerySchema
// ============================================================

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

// ============================================================
// usageConversationQuerySchema
// ============================================================

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

// ============================================================
// usageBalanceHistoryQuerySchema
// ============================================================

describe('usageBalanceHistoryQuerySchema', () => {
  it('defaults limit to 200', () => {
    const result = usageBalanceHistoryQuerySchema.parse({
      startDate: '2026-01-01',
      endDate: '2026-03-27',
    });
    expect(result.limit).toBe(200);
  });

  it('rejects limit above 500', () => {
    expect(() =>
      usageBalanceHistoryQuerySchema.parse({
        startDate: '2026-01-01',
        endDate: '2026-03-27',
        limit: 501,
      })
    ).toThrow();
  });
});

// ============================================================
// Response schemas
// ============================================================

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

describe('tokenUsageOverTimeResponseSchema', () => {
  it('accepts valid token data', () => {
    const result = tokenUsageOverTimeResponseSchema.parse({
      data: [{ period: '2026-01-01', inputTokens: 1000, outputTokens: 2000, cachedTokens: 500 }],
    });
    expect(result.data[0]?.inputTokens).toBe(1000);
  });
});

describe('spendingByConversationResponseSchema', () => {
  it('accepts valid conversation data', () => {
    const result = spendingByConversationResponseSchema.parse({
      data: [
        { conversationId: 'conv-1', totalSpent: '3.50' },
        { conversationId: 'conv-2', totalSpent: '1.20' },
      ],
    });
    expect(result.data).toHaveLength(2);
  });
});

describe('balanceHistoryResponseSchema', () => {
  it('accepts valid balance history', () => {
    const result = balanceHistoryResponseSchema.parse({
      data: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          balanceAfter: '10.00000000',
          entryType: 'deposit',
          amount: '10.00000000',
        },
      ],
    });
    expect(result.data[0]?.entryType).toBe('deposit');
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
