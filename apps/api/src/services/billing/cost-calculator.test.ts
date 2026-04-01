import { describe, it, expect } from 'vitest';
import { calculateMessageCost } from './cost-calculator.js';

describe('calculateMessageCost', () => {
  const mockModelInfo = {
    id: 'test-model',
    pricing: { prompt: '0.001', completion: '0.002' },
  };

  describe('inlineCost defined (production path)', () => {
    it('uses calculateMessageCostFromOpenRouter when inlineCost is provided', () => {
      const result = calculateMessageCost({
        inlineCost: 0.0025,
        modelInfo: mockModelInfo,
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        webSearchCost: 0,
      });

      expect(result).toBeGreaterThan(0);
    });

    it('includes storage fee in total cost', () => {
      const inlineCost = 0.001;

      const result = calculateMessageCost({
        inlineCost,
        modelInfo: mockModelInfo,
        inputContent: 'Short input',
        outputContent: 'Short output',
        webSearchCost: 0,
      });

      // Total should include OpenRouter cost + storage fee
      expect(result).toBeGreaterThan(inlineCost);
    });
  });

  describe('inlineCost undefined (estimation fallback)', () => {
    it('falls back to estimation when inlineCost is undefined', () => {
      const result = calculateMessageCost({
        inlineCost: undefined,
        modelInfo: mockModelInfo,
        inputContent: 'Hello world',
        outputContent: 'Hello! How can I help you today?',
        webSearchCost: 0,
      });

      expect(result).toBeGreaterThan(0);
    });

    it('returns 0 when inlineCost is undefined and modelInfo is missing', () => {
      const result = calculateMessageCost({
        inlineCost: undefined,
        modelInfo: undefined,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      expect(result).toBe(0);
    });
  });

  describe('web search cost', () => {
    it('does not add webSearchCost when inlineCost is present (OpenRouter total includes it)', () => {
      const withSearch = calculateMessageCost({
        inlineCost: 0.05,
        modelInfo: mockModelInfo,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0.03,
      });

      const withoutSearch = calculateMessageCost({
        inlineCost: 0.05,
        modelInfo: mockModelInfo,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      // inlineCost path ignores webSearchCost — OpenRouter's cost already includes it
      expect(withSearch).toBe(withoutSearch);
    });

    it('includes webSearchCost in estimation path', () => {
      const withoutSearch = calculateMessageCost({
        inlineCost: undefined,
        modelInfo: mockModelInfo,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0,
      });

      const withSearch = calculateMessageCost({
        inlineCost: undefined,
        modelInfo: mockModelInfo,
        inputContent: 'Hello',
        outputContent: 'World',
        webSearchCost: 0.03,
      });

      expect(withSearch).toBeGreaterThan(withoutSearch);
    });
  });
});
