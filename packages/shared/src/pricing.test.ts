import { describe, it, expect } from 'vitest';
import { calculateMessageCost } from './pricing.js';
import type { MessageCostParams } from './pricing.js';
import { LOME_FEE_RATE, STORAGE_COST_PER_CHARACTER } from './constants.js';

describe('calculateMessageCost', () => {
  const baseParams: MessageCostParams = {
    inputTokens: 100,
    outputTokens: 200,
    inputCharacters: 400,
    outputCharacters: 800,
    pricePerInputToken: 0.00001,
    pricePerOutputToken: 0.00003,
  };

  describe('model cost calculation', () => {
    it('calculates model cost from tokens and prices', () => {
      const result = calculateMessageCost(baseParams);
      const expectedModelCost = 100 * 0.00001 + 200 * 0.00003; // 0.007
      const expectedLomeFee = expectedModelCost * LOME_FEE_RATE;
      const expectedStorageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(expectedModelCost + expectedLomeFee + expectedStorageFee, 10);
    });

    it('handles zero tokens', () => {
      const result = calculateMessageCost({
        ...baseParams,
        inputTokens: 0,
        outputTokens: 0,
      });
      // Only storage fee remains
      const expectedStorageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;
      expect(result).toBeCloseTo(expectedStorageFee, 10);
    });

    it('handles zero price per token', () => {
      const result = calculateMessageCost({
        ...baseParams,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
      });
      // Only storage fee remains
      const expectedStorageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;
      expect(result).toBeCloseTo(expectedStorageFee, 10);
    });
  });

  describe('LOME fee calculation', () => {
    it('applies LOME_FEE_RATE to model cost only', () => {
      const paramsNoStorage: MessageCostParams = {
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCost(paramsNoStorage);
      const modelCost = 100 * 0.00001 + 200 * 0.00003;

      expect(result).toBeCloseTo(modelCost * (1 + LOME_FEE_RATE), 10);
    });

    it('does not apply LOME fee to storage fee', () => {
      const modelOnlyResult = calculateMessageCost({
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      });
      const fullResult = calculateMessageCost(baseParams);
      const storageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;

      // Full result should be model cost with LOME fee + raw storage fee (no LOME fee on storage)
      expect(fullResult).toBeCloseTo(modelOnlyResult + storageFee, 10);
    });
  });

  describe('storage fee calculation', () => {
    it('charges storage fee per character for input and output', () => {
      const paramsNoModel: MessageCostParams = {
        inputTokens: 0,
        outputTokens: 0,
        inputCharacters: 1000,
        outputCharacters: 1000,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
      };
      const result = calculateMessageCost(paramsNoModel);

      expect(result).toBeCloseTo(2000 * STORAGE_COST_PER_CHARACTER, 10);
    });

    it('applies storage fee to input and output independently', () => {
      const inputOnly = calculateMessageCost({
        inputTokens: 0,
        outputTokens: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        inputCharacters: 500,
        outputCharacters: 0,
      });
      const outputOnly = calculateMessageCost({
        inputTokens: 0,
        outputTokens: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        inputCharacters: 0,
        outputCharacters: 500,
      });

      expect(inputOnly).toBeCloseTo(500 * STORAGE_COST_PER_CHARACTER, 10);
      expect(outputOnly).toBeCloseTo(500 * STORAGE_COST_PER_CHARACTER, 10);
      expect(inputOnly).toBe(outputOnly);
    });

    it('handles zero characters', () => {
      const result = calculateMessageCost({
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      });
      const modelCost = 100 * 0.00001 + 200 * 0.00003;

      expect(result).toBeCloseTo(modelCost * (1 + LOME_FEE_RATE), 10);
    });
  });

  describe('combined calculation', () => {
    it('sums model cost, LOME fee, and storage fee', () => {
      const result = calculateMessageCost(baseParams);

      const modelCost = 100 * 0.00001 + 200 * 0.00003;
      const lomeFee = modelCost * LOME_FEE_RATE;
      const storageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + lomeFee + storageFee, 10);
    });

    it('returns correct result with real-world pricing', () => {
      // GPT-4 style pricing: $0.03/1k input, $0.06/1k output
      const gpt4Params: MessageCostParams = {
        inputTokens: 1000,
        outputTokens: 500,
        inputCharacters: 4000,
        outputCharacters: 2000,
        pricePerInputToken: 0.00003,
        pricePerOutputToken: 0.00006,
      };
      const result = calculateMessageCost(gpt4Params);

      const modelCost = 1000 * 0.00003 + 500 * 0.00006; // 0.03 + 0.03 = 0.06
      const lomeFee = modelCost * LOME_FEE_RATE; // 0.06 * 0.15 = 0.009
      const storageFee = (4000 + 2000) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + lomeFee + storageFee, 10);
    });

    it('handles very large messages', () => {
      const largeParams: MessageCostParams = {
        inputTokens: 100000,
        outputTokens: 100000,
        inputCharacters: 400000,
        outputCharacters: 400000,
        pricePerInputToken: 0.00001,
        pricePerOutputToken: 0.00003,
      };
      const result = calculateMessageCost(largeParams);

      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });

    it('handles very small values without precision loss', () => {
      const smallParams: MessageCostParams = {
        inputTokens: 1,
        outputTokens: 1,
        inputCharacters: 1,
        outputCharacters: 1,
        pricePerInputToken: 0.0000001,
        pricePerOutputToken: 0.0000001,
      };
      const result = calculateMessageCost(smallParams);

      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns 0 when all inputs are 0', () => {
      const zeroParams: MessageCostParams = {
        inputTokens: 0,
        outputTokens: 0,
        inputCharacters: 0,
        outputCharacters: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
      };
      const result = calculateMessageCost(zeroParams);

      expect(result).toBe(0);
    });

    it('correctly handles input-only messages', () => {
      const inputOnlyParams: MessageCostParams = {
        inputTokens: 100,
        outputTokens: 0,
        inputCharacters: 400,
        outputCharacters: 0,
        pricePerInputToken: 0.00001,
        pricePerOutputToken: 0.00003,
      };
      const result = calculateMessageCost(inputOnlyParams);

      const modelCost = 100 * 0.00001;
      const lomeFee = modelCost * LOME_FEE_RATE;
      const storageFee = 400 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + lomeFee + storageFee, 10);
    });

    it('correctly handles output-only messages', () => {
      const outputOnlyParams: MessageCostParams = {
        inputTokens: 0,
        outputTokens: 200,
        inputCharacters: 0,
        outputCharacters: 800,
        pricePerInputToken: 0.00001,
        pricePerOutputToken: 0.00003,
      };
      const result = calculateMessageCost(outputOnlyParams);

      const modelCost = 200 * 0.00003;
      const lomeFee = modelCost * LOME_FEE_RATE;
      const storageFee = 800 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + lomeFee + storageFee, 10);
    });
  });
});
