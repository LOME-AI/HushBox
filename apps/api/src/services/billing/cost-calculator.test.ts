import { describe, it, expect, vi } from 'vitest';
import { calculateMessageCost } from './cost-calculator.js';
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
