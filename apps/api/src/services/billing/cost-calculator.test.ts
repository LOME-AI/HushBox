import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateMessageCost } from './cost-calculator.js';

describe('calculateMessageCost', () => {
  const mockOpenRouter = {
    getGenerationStats: vi.fn(),
  };

  const mockModelInfo = {
    id: 'test-model',
    pricing: { prompt: '0.001', completion: '0.002' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('production mode (with generationId)', () => {
    it('fetches stats from OpenRouter and calculates cost', async () => {
      mockOpenRouter.getGenerationStats.mockResolvedValue({
        total_cost: 0.0025,
      });

      const result = await calculateMessageCost({
        openrouter: mockOpenRouter,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        isProduction: true,
      });

      expect(mockOpenRouter.getGenerationStats).toHaveBeenCalledWith('gen-123');
      expect(result).toBeGreaterThan(0);
    });

    it('falls back to estimation if getGenerationStats fails', async () => {
      mockOpenRouter.getGenerationStats.mockRejectedValue(new Error('API error'));

      const result = await calculateMessageCost({
        openrouter: mockOpenRouter,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello',
        outputContent: 'World',
        isProduction: true,
      });

      // Should fall back to estimation, not throw
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('development mode (no generationId or isProduction=false)', () => {
    it('estimates cost from character count when isProduction is false', async () => {
      const result = await calculateMessageCost({
        openrouter: mockOpenRouter,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        isProduction: false,
      });

      // Should NOT call getGenerationStats in dev mode
      expect(mockOpenRouter.getGenerationStats).not.toHaveBeenCalled();
      expect(result).toBeGreaterThan(0);
    });

    it('estimates cost when no generationId provided', async () => {
      const result = await calculateMessageCost({
        openrouter: mockOpenRouter,
        modelInfo: mockModelInfo,
        generationId: undefined,
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        isProduction: true,
      });

      expect(mockOpenRouter.getGenerationStats).not.toHaveBeenCalled();
      expect(result).toBeGreaterThan(0);
    });

    it('returns 0 when model pricing info is missing', async () => {
      const result = await calculateMessageCost({
        openrouter: mockOpenRouter,
        modelInfo: undefined,
        generationId: undefined,
        inputContent: 'Hello',
        outputContent: 'World',
        isProduction: false,
      });

      expect(result).toBe(0);
    });
  });

  describe('cost calculation', () => {
    it('includes storage fee in total cost', async () => {
      mockOpenRouter.getGenerationStats.mockResolvedValue({
        total_cost: 0.001,
      });

      const result = await calculateMessageCost({
        openrouter: mockOpenRouter,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Short input',
        outputContent: 'Short output',
        isProduction: true,
      });

      // Total should include OpenRouter cost + storage fee
      expect(result).toBeGreaterThan(0.001);
    });
  });
});
