import { describe, it, expect, vi } from 'vitest';
import { applyFees, type PreInferenceBilling } from '@hushbox/shared';
import { calculateMessageCost, calculateMessageCostWithStages } from './cost-calculator.js';
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
