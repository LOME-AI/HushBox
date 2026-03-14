import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateMessageCost } from './cost-calculator.js';

describe('calculateMessageCost', () => {
  const createMockOpenRouter = (isMock: boolean) => ({
    isMock,
    getGenerationStats: vi.fn(),
  });

  const mockModelInfo = {
    id: 'test-model',
    pricing: { prompt: '0.001', completion: '0.002' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('real client mode (isMock=false with generationId)', () => {
    it('fetches stats from OpenRouter and calculates cost', async () => {
      const realClient = createMockOpenRouter(false);
      realClient.getGenerationStats.mockResolvedValue({
        total_cost: 0.0025,
      });

      const result = await calculateMessageCost({
        openrouter: realClient,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        webSearchCost: 0,
      });

      expect(realClient.getGenerationStats).toHaveBeenCalledWith('gen-123');
      expect(result).toBeGreaterThan(0);
    });

    it('falls back to estimation if getGenerationStats fails', async () => {
      const realClient = createMockOpenRouter(false);
      realClient.getGenerationStats.mockRejectedValue(new Error('API error'));

      const result = await calculateMessageCost({
        openrouter: realClient,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      // Should fall back to estimation, not throw
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('mock client mode (isMock=true or no generationId)', () => {
    it('estimates cost from character count when isMock is true', async () => {
      const mockClient = createMockOpenRouter(true);

      const result = await calculateMessageCost({
        openrouter: mockClient,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        webSearchCost: 0,
      });

      // Should NOT call getGenerationStats for mock client
      expect(mockClient.getGenerationStats).not.toHaveBeenCalled();
      expect(result).toBeGreaterThan(0);
    });

    it('estimates cost when no generationId provided', async () => {
      const realClient = createMockOpenRouter(false);

      const result = await calculateMessageCost({
        openrouter: realClient,
        modelInfo: mockModelInfo,
        generationId: undefined,
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        webSearchCost: 0,
      });

      expect(realClient.getGenerationStats).not.toHaveBeenCalled();
      expect(result).toBeGreaterThan(0);
    });

    it('returns 0 when model pricing info is missing', async () => {
      const mockClient = createMockOpenRouter(true);

      const result = await calculateMessageCost({
        openrouter: mockClient,
        modelInfo: undefined,
        generationId: undefined,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      expect(result).toBe(0);
    });
  });

  describe('cost calculation', () => {
    it('includes storage fee in total cost', async () => {
      const realClient = createMockOpenRouter(false);
      realClient.getGenerationStats.mockResolvedValue({
        total_cost: 0.001,
      });

      const result = await calculateMessageCost({
        openrouter: realClient,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Short input',
        outputContent: 'Short output',
        webSearchCost: 0,
      });

      // Total should include OpenRouter cost + storage fee
      expect(result).toBeGreaterThan(0.001);
    });
  });

  describe('web search cost', () => {
    it('includes webSearchCost in mock client estimation', async () => {
      const mockClient = createMockOpenRouter(true);

      const withoutSearch = await calculateMessageCost({
        openrouter: mockClient,
        modelInfo: mockModelInfo,
        generationId: undefined,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      const withSearch = await calculateMessageCost({
        openrouter: mockClient,
        modelInfo: mockModelInfo,
        generationId: undefined,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0.03,
      });

      expect(withSearch).toBeGreaterThan(withoutSearch);
    });

    it('does not add webSearchCost in real client mode (OpenRouter total_cost includes it)', async () => {
      const realClient = createMockOpenRouter(false);
      realClient.getGenerationStats.mockResolvedValue({
        total_cost: 0.05, // Already includes search cost
      });

      const withSearch = await calculateMessageCost({
        openrouter: realClient,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0.03,
      });

      const withoutSearch = await calculateMessageCost({
        openrouter: realClient,
        modelInfo: mockModelInfo,
        generationId: 'gen-123',
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      // Real client uses OpenRouter total_cost directly — webSearchCost should not be added
      expect(withSearch).toBe(withoutSearch);
    });
  });
});
