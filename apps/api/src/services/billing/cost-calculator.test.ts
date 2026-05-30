import { describe, it, expect, vi } from 'vitest';
import { applyFees, STORAGE_COST_PER_CHARACTER, type PreInferenceBilling } from '@hushbox/shared';

const recordEvidenceMock = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return {
    ...actual,
    recordServiceEvidence: recordEvidenceMock,
  };
});

const {
  calculateMessageCost,
  calculateMessageCostWithStages,
  recordBillingMismatchIfExceeded,
  BILLING_MISMATCH_THRESHOLD_RATIO,
} = await import('./cost-calculator.js');
const { SERVICE_NAMES } = await import('@hushbox/db');
import type { AIClient } from '../ai/index.js';

function makeMockAIClient(costUsd: number): AIClient {
  return {
    isMock: true,
    listModels: vi.fn(),
    getModel: vi.fn(),
    stream: vi.fn(),
    getGenerationStats: vi.fn().mockResolvedValue({ costUsd }),
  } as unknown as AIClient;
}

function storageFee(inputContent: string, outputContent: string): number {
  return (inputContent.length + outputContent.length) * STORAGE_COST_PER_CHARACTER;
}

describe('calculateMessageCost', () => {
  it('fetches cost from aiClient.getGenerationStats and returns gateway cost + storage fee', async () => {
    const aiClient = makeMockAIClient(0.0025);

    const result = await calculateMessageCost({
      aiClient,
      generationId: 'gen-123',
      inputContent: 'Hello world',
      outputContent: 'Hello! How can I help you today?',
    });

    // Cost = applyFees(0.0025) + storage fee from chars > 0
    expect(result).toBeGreaterThan(0.0025);
    expect(aiClient.getGenerationStats).toHaveBeenCalledWith('gen-123');
  });

  it('includes storage fee on top of gateway cost', async () => {
    const aiClient = makeMockAIClient(0.001);

    const result = await calculateMessageCost({
      aiClient,
      generationId: 'gen-1',
      inputContent: 'Short input',
      outputContent: 'Short output',
    });

    // Total = applyFees(0.001) + storage > 0.001
    expect(result).toBeGreaterThan(0.001);
  });

  it('propagates errors from getGenerationStats (no silent estimation fallback)', async () => {
    const aiClient = {
      isMock: true,
      listModels: vi.fn(),
      getModel: vi.fn(),
      stream: vi.fn(),
      getGenerationStats: vi.fn().mockRejectedValue(new Error('Generation not found')),
    } as unknown as AIClient;

    await expect(
      calculateMessageCost({
        aiClient,
        generationId: 'gen-missing',
        inputContent: 'Hello',
        outputContent: 'World',
      })
    ).rejects.toThrow('Generation not found');
  });

  it('passes the provided generationId to the AIClient', async () => {
    const aiClient = makeMockAIClient(0.001);

    await calculateMessageCost({
      aiClient,
      generationId: 'gen-abc-xyz',
      inputContent: 'a',
      outputContent: 'b',
    });

    expect(aiClient.getGenerationStats).toHaveBeenCalledWith('gen-abc-xyz');
  });

  it('does not double-count web search cost — gateway totalCost already includes search', async () => {
    // Gateway returns 0.10 (which already bundles any search calls). The
    // calculator must not add another search reservation on top — it should
    // be exactly applyFees(0.10) plus the storage fee for the message bytes.
    const gatewayCost = 0.1;
    const aiClient = makeMockAIClient(gatewayCost);
    const inputContent = 'hi';
    const outputContent = 'world';

    const result = await calculateMessageCost({
      aiClient,
      generationId: 'gen-search-1',
      inputContent,
      outputContent,
    });

    const expected = applyFees(gatewayCost) + storageFee(inputContent, outputContent);
    expect(result).toBeCloseTo(expected, 10);
  });
});

describe('calculateMessageCostWithStages', () => {
  function makeMockClientByGenerationId(costsByGen: Record<string, number>): AIClient {
    return {
      isMock: true,
      listModels: vi.fn(),
      getModel: vi.fn(),
      stream: vi.fn(),
      getGenerationStats: vi.fn().mockImplementation((generationId: string) => {
        const costUsd = costsByGen[generationId];
        if (costUsd === undefined) {
          return Promise.reject(new Error(`No cost mock for ${generationId}`));
        }
        return Promise.resolve({ costUsd });
      }),
    } as unknown as AIClient;
  }

  function makeStageBilling(
    generationId: string,
    overrides: Partial<PreInferenceBilling> = {}
  ): PreInferenceBilling {
    return {
      stageId: 'smart-model',
      modelId: 'cheap/c',
      generationId,
      inputContent: 'classifier prompt',
      outputContent: 'cheap/c',
      ...overrides,
    };
  }

  it('returns totalDollars equal to main + stage attributions when there are no stages', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0.001 });
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      stageBillings: [],
      inputContent: 'in',
      outputContent: 'out',
    });
    expect(result.stageBreakdown).toEqual([]);
    expect(result.mainCostDollars).toBeCloseTo(result.totalDollars, 10);
    expect(result.totalDollars).toBeGreaterThan(0.001);
  });

  it('sums main + stage gateway costs into a single total with fees and storage', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0.005, classifier: 0.0001 });
    const stageBillings = [makeStageBilling('classifier')];
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      stageBillings,
      inputContent: 'in',
      outputContent: 'out',
    });
    const expectedStageCents = applyFees(0.0001);
    expect(result.stageBreakdown).toHaveLength(1);
    expect(result.stageBreakdown[0]?.gatewayCostUsd).toBeCloseTo(0.0001, 10);
    expect(result.stageBreakdown[0]?.costDollars).toBeCloseTo(expectedStageCents, 10);
    expect(result.mainCostDollars + result.stageBreakdown[0]!.costDollars).toBeCloseTo(
      result.totalDollars,
      10
    );
  });

  it('attributes storage entirely to the main cost, not to stages', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0, classifier: 0 });
    const stageBillings = [makeStageBilling('classifier')];
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      stageBillings,
      inputContent: 'a'.repeat(1000),
      outputContent: 'b'.repeat(1000),
    });
    // Stage cost = applyFees(0) = 0; main cost is entirely storage
    expect(result.stageBreakdown[0]?.costDollars).toBe(0);
    expect(result.mainCostDollars).toBeGreaterThan(0);
    expect(result.totalDollars).toBeCloseTo(result.mainCostDollars, 10);
  });

  it('handles multiple stages additively', async () => {
    const aiClient = makeMockClientByGenerationId({
      main: 0.01,
      stage1: 0.001,
      stage2: 0.002,
    });
    const stageBillings = [makeStageBilling('stage1'), makeStageBilling('stage2')];
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      stageBillings,
      inputContent: 'i',
      outputContent: 'o',
    });
    expect(result.stageBreakdown).toHaveLength(2);
    const sum =
      result.mainCostDollars + result.stageBreakdown.reduce((s, b) => s + b.costDollars, 0);
    expect(sum).toBeCloseTo(result.totalDollars, 10);
  });

  it('propagates errors from getGenerationStats for any call', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0.005 });
    // 'classifier' has no mock — getGenerationStats will reject
    const stageBillings = [makeStageBilling('classifier')];
    await expect(
      calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        stageBillings,
        inputContent: 'i',
        outputContent: 'o',
      })
    ).rejects.toThrow();
  });

  it('fetches all generation stats in parallel', async () => {
    const aiClient = makeMockClientByGenerationId({
      main: 0.01,
      stage1: 0.001,
      stage2: 0.002,
    });
    const callOrder: string[] = [];
    const COST_BY_ID: Record<string, number> = { main: 0.01, stage1: 0.001, stage2: 0.002 };
    type StatsImpl = (id: string) => Promise<{ costUsd: number }>;
    const mockedStats = aiClient.getGenerationStats as ReturnType<typeof vi.fn> & {
      mockImplementation(implementation: StatsImpl): unknown;
    };
    mockedStats.mockImplementation((id: string) => {
      callOrder.push(`start:${id}`);
      // simulate different latencies
      const delay = id === 'main' ? 5 : 1;
      const cost = COST_BY_ID[id] ?? 0;
      return new Promise<{ costUsd: number }>((resolve) => {
        const finish = (): void => {
          callOrder.push(`end:${id}`);
          resolve({ costUsd: cost });
        };
        setTimeout(finish, delay);
      });
    });
    await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      stageBillings: [makeStageBilling('stage1'), makeStageBilling('stage2')],
      inputContent: 'i',
      outputContent: 'o',
    });
    // Parallel: all starts come before any ends — even though main is slowest.
    expect(callOrder.slice(0, 3).every((s) => s.startsWith('start:'))).toBe(true);
  });
});

describe('recordBillingMismatchIfExceeded', () => {
  const fakeDb = { __fake: 'db' } as unknown as import('@hushbox/db').Database;

  it('exposes a sensible default threshold', () => {
    // Threshold is a fractional ratio (e.g. 0.5 == 50% deviation tolerated).
    expect(BILLING_MISMATCH_THRESHOLD_RATIO).toBeGreaterThan(0);
    expect(BILLING_MISMATCH_THRESHOLD_RATIO).toBeLessThan(1);
  });

  it('records evidence when actual exceeds estimate by more than the threshold', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.01,
      actualUsd: 0.02, // +100% deviation
      evidence: { db: fakeDb, isCI: true },
    });

    expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
    expect(recordEvidenceMock).toHaveBeenCalledWith(
      fakeDb,
      true,
      SERVICE_NAMES.BILLING_MISMATCH,
      expect.objectContaining({
        estimateUsd: 0.01,
        actualUsd: 0.02,
      })
    );
  });

  it('records evidence when actual undershoots estimate by more than the threshold', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.1,
      actualUsd: 0.01, // 90% under
      evidence: { db: fakeDb, isCI: true },
    });
    expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
  });

  it('does not record evidence when within the threshold', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.1,
      actualUsd: 0.11, // +10% deviation
      evidence: { db: fakeDb, isCI: true },
    });
    expect(recordEvidenceMock).not.toHaveBeenCalled();
  });

  it('does not record evidence when no evidence config is supplied', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.01,
      actualUsd: 1,
    });
    expect(recordEvidenceMock).not.toHaveBeenCalled();
  });

  it('records when actual is non-zero against a zero estimate', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0,
      actualUsd: 0.5,
      evidence: { db: fakeDb, isCI: true },
    });
    // A non-zero actual against a zero estimate is, by any sane definition,
    // an unbounded deviation — record it.
    expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
  });

  it('does not record when both estimate and actual are zero', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0,
      actualUsd: 0,
      evidence: { db: fakeDb, isCI: true },
    });
    expect(recordEvidenceMock).not.toHaveBeenCalled();
  });
});
