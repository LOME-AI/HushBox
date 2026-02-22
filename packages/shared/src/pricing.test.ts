import { describe, it, expect } from 'vitest';
import {
  applyFees,
  calculateTokenCostWithFees,
  estimateMessageCostDevelopment,
  calculateMessageCostFromOpenRouter,
  estimateTokenCount,
  getModelCostPer1k,
  isExpensiveModel,
} from './pricing.js';
import type { MessageCostParams, MessageCostFromOpenRouterParams } from './pricing.js';
import {
  TOTAL_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
} from './constants.js';

describe('applyFees', () => {
  it('applies total fee rate (15%) to base price', () => {
    expect(applyFees(1)).toBeCloseTo(1.15, 10);
    expect(applyFees(10)).toBeCloseTo(11.5, 10);
    expect(applyFees(100)).toBeCloseTo(115, 10);
  });

  it('handles zero price', () => {
    expect(applyFees(0)).toBe(0);
  });

  it('handles very small prices', () => {
    expect(applyFees(0.000_01)).toBeCloseTo(0.000_011_5, 10);
  });
});

describe('calculateTokenCostWithFees', () => {
  it('calculates token cost and applies fees', () => {
    const result = calculateTokenCostWithFees(100, 200, 0.000_01, 0.000_03);
    const baseCost = 100 * 0.000_01 + 200 * 0.000_03;
    expect(result).toBeCloseTo(applyFees(baseCost), 10);
  });

  it('handles zero tokens', () => {
    const result = calculateTokenCostWithFees(0, 0, 0.000_01, 0.000_03);
    expect(result).toBe(0);
  });

  it('handles input tokens only', () => {
    const result = calculateTokenCostWithFees(100, 0, 0.000_01, 0.000_03);
    const baseCost = 100 * 0.000_01;
    expect(result).toBeCloseTo(applyFees(baseCost), 10);
  });

  it('handles output tokens only', () => {
    const result = calculateTokenCostWithFees(0, 200, 0.000_01, 0.000_03);
    const baseCost = 200 * 0.000_03;
    expect(result).toBeCloseTo(applyFees(baseCost), 10);
  });
});

describe('estimateTokenCount', () => {
  it('estimates tokens using chars/4 heuristic', () => {
    expect(estimateTokenCount('hello')).toBe(2); // 5 chars -> ceil(5/4) = 2
    expect(estimateTokenCount('hello world')).toBe(3); // 11 chars -> ceil(11/4) = 3
  });

  it('handles empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('handles single character', () => {
    expect(estimateTokenCount('a')).toBe(1);
  });

  it('handles exactly 4 characters', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
  });

  it('handles 5 characters (rounds up)', () => {
    expect(estimateTokenCount('abcde')).toBe(2);
  });

  it('handles large text', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokenCount(text)).toBe(250);
  });
});

describe('estimateMessageCostDevelopment', () => {
  const baseParams: MessageCostParams = {
    inputTokens: 100,
    outputTokens: 200,
    inputCharacters: 400,
    outputCharacters: 800,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
  };

  describe('model cost calculation', () => {
    it('calculates model cost from tokens and prices', () => {
      const result = estimateMessageCostDevelopment(baseParams);
      const expectedModelCost = 100 * 0.000_01 + 200 * 0.000_03; // 0.007
      const expectedHushboxFee = expectedModelCost * TOTAL_FEE_RATE;
      const expectedStorageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(expectedModelCost + expectedHushboxFee + expectedStorageFee, 10);
    });

    it('handles zero tokens', () => {
      const result = estimateMessageCostDevelopment({
        ...baseParams,
        inputTokens: 0,
        outputTokens: 0,
      });
      // Only storage fee remains
      const expectedStorageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;
      expect(result).toBeCloseTo(expectedStorageFee, 10);
    });

    it('handles zero price per token', () => {
      const result = estimateMessageCostDevelopment({
        ...baseParams,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
      });
      // Only storage fee remains
      const expectedStorageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;
      expect(result).toBeCloseTo(expectedStorageFee, 10);
    });
  });

  describe('HushBox fee calculation', () => {
    it('applies TOTAL_FEE_RATE to model cost only', () => {
      const paramsNoStorage: MessageCostParams = {
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = estimateMessageCostDevelopment(paramsNoStorage);
      const modelCost = 100 * 0.000_01 + 200 * 0.000_03;

      expect(result).toBeCloseTo(modelCost * (1 + TOTAL_FEE_RATE), 10);
    });

    it('does not apply HushBox fee to storage fee', () => {
      const modelOnlyResult = estimateMessageCostDevelopment({
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      });
      const fullResult = estimateMessageCostDevelopment(baseParams);
      const storageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;

      // Full result should be model cost with HushBox fee + raw storage fee (no HushBox fee on storage)
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
      const result = estimateMessageCostDevelopment(paramsNoModel);

      expect(result).toBeCloseTo(2000 * STORAGE_COST_PER_CHARACTER, 10);
    });

    it('applies storage fee to input and output independently', () => {
      const inputOnly = estimateMessageCostDevelopment({
        inputTokens: 0,
        outputTokens: 0,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        inputCharacters: 500,
        outputCharacters: 0,
      });
      const outputOnly = estimateMessageCostDevelopment({
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
      const result = estimateMessageCostDevelopment({
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      });
      const modelCost = 100 * 0.000_01 + 200 * 0.000_03;

      expect(result).toBeCloseTo(modelCost * (1 + TOTAL_FEE_RATE), 10);
    });
  });

  describe('combined calculation', () => {
    it('sums model cost, HushBox fee, and storage fee', () => {
      const result = estimateMessageCostDevelopment(baseParams);

      const modelCost = 100 * 0.000_01 + 200 * 0.000_03;
      const hushboxFee = modelCost * TOTAL_FEE_RATE;
      const storageFee = (400 + 800) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + hushboxFee + storageFee, 10);
    });

    it('returns correct result with real-world pricing', () => {
      // GPT-4 style pricing: $0.03/1k input, $0.06/1k output
      const gpt4Params: MessageCostParams = {
        inputTokens: 1000,
        outputTokens: 500,
        inputCharacters: 4000,
        outputCharacters: 2000,
        pricePerInputToken: 0.000_03,
        pricePerOutputToken: 0.000_06,
      };
      const result = estimateMessageCostDevelopment(gpt4Params);

      const modelCost = 1000 * 0.000_03 + 500 * 0.000_06; // 0.03 + 0.03 = 0.06
      const hushboxFee = modelCost * TOTAL_FEE_RATE; // 0.06 * 0.15 = 0.009
      const storageFee = (4000 + 2000) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + hushboxFee + storageFee, 10);
    });

    it('handles very large messages', () => {
      const largeParams: MessageCostParams = {
        inputTokens: 100_000,
        outputTokens: 100_000,
        inputCharacters: 400_000,
        outputCharacters: 400_000,
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
      };
      const result = estimateMessageCostDevelopment(largeParams);

      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });

    it('handles very small values without precision loss', () => {
      const smallParams: MessageCostParams = {
        inputTokens: 1,
        outputTokens: 1,
        inputCharacters: 1,
        outputCharacters: 1,
        pricePerInputToken: 0.000_000_1,
        pricePerOutputToken: 0.000_000_1,
      };
      const result = estimateMessageCostDevelopment(smallParams);

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
      const result = estimateMessageCostDevelopment(zeroParams);

      expect(result).toBe(0);
    });

    it('correctly handles input-only messages', () => {
      const inputOnlyParams: MessageCostParams = {
        inputTokens: 100,
        outputTokens: 0,
        inputCharacters: 400,
        outputCharacters: 0,
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
      };
      const result = estimateMessageCostDevelopment(inputOnlyParams);

      const modelCost = 100 * 0.000_01;
      const hushboxFee = modelCost * TOTAL_FEE_RATE;
      const storageFee = 400 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + hushboxFee + storageFee, 10);
    });

    it('correctly handles output-only messages', () => {
      const outputOnlyParams: MessageCostParams = {
        inputTokens: 0,
        outputTokens: 200,
        inputCharacters: 0,
        outputCharacters: 800,
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
      };
      const result = estimateMessageCostDevelopment(outputOnlyParams);

      const modelCost = 200 * 0.000_03;
      const hushboxFee = modelCost * TOTAL_FEE_RATE;
      const storageFee = 800 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCost + hushboxFee + storageFee, 10);
    });
  });
});

describe('calculateMessageCostFromOpenRouter', () => {
  const baseParams: MessageCostFromOpenRouterParams = {
    openRouterCost: 0.001, // $0.001 from OpenRouter
    inputCharacters: 500,
    outputCharacters: 200,
  };

  describe('model cost with fees', () => {
    it('applies 15% fee to OpenRouter exact cost', () => {
      const result = calculateMessageCostFromOpenRouter(baseParams);
      const expectedModelCostWithFees = applyFees(0.001);
      const expectedStorageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(expectedModelCostWithFees + expectedStorageFee, 10);
    });

    it('correctly calculates fee ratio as exactly 1.15x', () => {
      const paramsNoStorage: MessageCostFromOpenRouterParams = {
        openRouterCost: 0.01,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromOpenRouter(paramsNoStorage);

      expect(result / 0.01).toBeCloseTo(1 + TOTAL_FEE_RATE, 10);
    });

    it('handles zero OpenRouter cost', () => {
      const zeroCostParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0,
        inputCharacters: 500,
        outputCharacters: 200,
      };
      const result = calculateMessageCostFromOpenRouter(zeroCostParams);
      const expectedStorageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(expectedStorageFee, 10);
    });

    it('handles very small OpenRouter costs', () => {
      const smallCostParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0.000_000_1,
        inputCharacters: 10,
        outputCharacters: 10,
      };
      const result = calculateMessageCostFromOpenRouter(smallCostParams);

      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('storage fee calculation', () => {
    it('charges storage fee per character', () => {
      const paramsNoModelCost: MessageCostFromOpenRouterParams = {
        openRouterCost: 0,
        inputCharacters: 1000,
        outputCharacters: 1000,
      };
      const result = calculateMessageCostFromOpenRouter(paramsNoModelCost);

      expect(result).toBeCloseTo(2000 * STORAGE_COST_PER_CHARACTER, 10);
    });

    it('does not apply fees to storage cost', () => {
      const modelOnlyResult = calculateMessageCostFromOpenRouter({
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      });
      const fullResult = calculateMessageCostFromOpenRouter(baseParams);
      const storageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      // Full result should be model cost with fees + raw storage fee (no fees on storage)
      expect(fullResult).toBeCloseTo(modelOnlyResult + storageFee, 10);
    });

    it('handles zero characters', () => {
      const noCharsParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0.001,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromOpenRouter(noCharsParams);

      expect(result).toBeCloseTo(applyFees(0.001), 10);
    });
  });

  describe('combined calculation', () => {
    it('sums model cost with fees and storage fee', () => {
      const result = calculateMessageCostFromOpenRouter(baseParams);

      const modelCostWithFees = 0.001 * (1 + TOTAL_FEE_RATE);
      const storageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });

    it('returns correct result with real-world OpenRouter cost', () => {
      // Typical GPT-4 response costing $0.05
      const realWorldParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0.05,
        inputCharacters: 4000,
        outputCharacters: 2000,
      };
      const result = calculateMessageCostFromOpenRouter(realWorldParams);

      const modelCostWithFees = 0.05 * (1 + TOTAL_FEE_RATE); // 0.0575
      const storageFee = (4000 + 2000) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });

    it('handles large OpenRouter costs', () => {
      const largeCostParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 10, // $10 for expensive operation
        inputCharacters: 100_000,
        outputCharacters: 100_000,
      };
      const result = calculateMessageCostFromOpenRouter(largeCostParams);

      expect(result).toBeGreaterThan(10);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns 0 when all inputs are 0', () => {
      const zeroParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromOpenRouter(zeroParams);

      expect(result).toBe(0);
    });

    it('handles input characters only', () => {
      const inputOnlyParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0.001,
        inputCharacters: 500,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromOpenRouter(inputOnlyParams);

      const modelCostWithFees = applyFees(0.001);
      const storageFee = 500 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });

    it('handles output characters only', () => {
      const outputOnlyParams: MessageCostFromOpenRouterParams = {
        openRouterCost: 0.001,
        inputCharacters: 0,
        outputCharacters: 200,
      };
      const result = calculateMessageCostFromOpenRouter(outputOnlyParams);

      const modelCostWithFees = applyFees(0.001);
      const storageFee = 200 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });
  });
});

describe('getModelCostPer1k', () => {
  it('calculates combined cost per 1k tokens with fees applied', () => {
    // input: $0.01/1k, output: $0.03/1k → combined base: $0.04/1k → with 15% fee: $0.046/1k
    const result = getModelCostPer1k(0.000_01, 0.000_03);
    const baseCostPer1k = (0.000_01 + 0.000_03) * 1000; // 0.04
    expect(result).toBeCloseTo(applyFees(baseCostPer1k), 10);
  });

  it('handles zero prices', () => {
    expect(getModelCostPer1k(0, 0)).toBe(0);
  });

  it('handles input price only', () => {
    const result = getModelCostPer1k(0.000_01, 0);
    const baseCostPer1k = 0.000_01 * 1000; // 0.01
    expect(result).toBeCloseTo(applyFees(baseCostPer1k), 10);
  });

  it('handles output price only', () => {
    const result = getModelCostPer1k(0, 0.000_03);
    const baseCostPer1k = 0.000_03 * 1000; // 0.03
    expect(result).toBeCloseTo(applyFees(baseCostPer1k), 10);
  });

  it('handles very small prices', () => {
    // Llama-style cheap pricing
    const result = getModelCostPer1k(0.000_000_59, 0.000_000_79);
    const baseCostPer1k = (0.000_000_59 + 0.000_000_79) * 1000;
    expect(result).toBeCloseTo(applyFees(baseCostPer1k), 10);
  });

  it('handles expensive model pricing', () => {
    // Claude Opus-style expensive pricing: $15/1M input, $75/1M output
    const result = getModelCostPer1k(0.000_015, 0.000_075);
    const baseCostPer1k = (0.000_015 + 0.000_075) * 1000; // 0.09
    expect(result).toBeCloseTo(applyFees(baseCostPer1k), 10);
  });
});

describe('isExpensiveModel', () => {
  it('returns false for cheap models (well below threshold)', () => {
    // Llama 3.1 70B: $0.00159/1k with fees - way below $0.10
    expect(isExpensiveModel(0.000_000_59, 0.000_000_79)).toBe(false);
  });

  it('returns false for mid-range models (below threshold)', () => {
    // GPT-4 Turbo: $0.046/1k with fees - below $0.10
    expect(isExpensiveModel(0.000_01, 0.000_03)).toBe(false);
  });

  it('returns true when exactly at threshold', () => {
    // Need prices that result in exactly $0.10 per 1k with fees
    // $0.10 = baseCostPer1k * 1.15
    // baseCostPer1k = $0.10 / 1.15 ≈ $0.0869565
    // Per token = $0.0869565 / 1000 / 2 ≈ $0.0000434783 each
    const pricePerToken = 0.1 / (1 + TOTAL_FEE_RATE) / 1000 / 2;
    expect(isExpensiveModel(pricePerToken, pricePerToken)).toBe(true);
  });

  it('returns false when just below threshold', () => {
    // Slightly below $0.10 threshold
    const pricePerToken = (0.1 / (1 + TOTAL_FEE_RATE) / 1000 / 2) * 0.99;
    expect(isExpensiveModel(pricePerToken, pricePerToken)).toBe(false);
  });

  it('returns true for expensive models (above threshold)', () => {
    // High-end model: input $0.05/1k, output $0.05/1k → $0.115/1k with fees
    expect(isExpensiveModel(0.000_05, 0.000_05)).toBe(true);
  });

  it('uses EXPENSIVE_MODEL_THRESHOLD_PER_1K constant', () => {
    // Verify the threshold constant is $0.10
    expect(EXPENSIVE_MODEL_THRESHOLD_PER_1K).toBe(0.1);
  });
});
