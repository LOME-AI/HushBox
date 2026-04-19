import { describe, it, expect } from 'vitest';
import {
  applyFees,
  calculateTokenCostWithFees,
  estimateMessageCostDevelopment,
  calculateMessageCostFromActual,
  estimateTokenCount,
  getModelCostPer1k,
  isExpensiveModel,
  effectiveOutputCostPerToken,
  getModelPricing,
  parseTokenPrice,
  mediaStorageCost,
  calculateMediaGenerationCost,
  computeImageWorstCaseCents,
  estimateVideoWorstCaseCents,
  computeImageExactCents,
  computeVideoExactCents,
} from './pricing.js';
import type { MessageCostParams, MessageCostFromActualParams } from './pricing.js';
import {
  TOTAL_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  CHARS_PER_TOKEN_STANDARD,
  CHARS_PER_TOKEN_CONSERVATIVE,
  MEDIA_STORAGE_COST_PER_BYTE,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
} from './constants.js';

describe('parseTokenPrice', () => {
  it('parses a valid positive price string', () => {
    expect(parseTokenPrice('0.000015')).toBe(0.000_015);
  });

  it('returns 0 for gateway negative sentinel "-1"', () => {
    expect(parseTokenPrice('-1')).toBe(0);
  });

  it('parses zero as 0', () => {
    expect(parseTokenPrice('0')).toBe(0);
  });

  it('returns 0 for empty string (NaN)', () => {
    expect(parseTokenPrice('')).toBe(0);
  });

  it('returns 0 for any negative value', () => {
    expect(parseTokenPrice('-0.5')).toBe(0);
  });
});

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

  describe('web search cost', () => {
    it('adds webSearchCost with fees to total', () => {
      const searchCost = 0.005;
      const result = estimateMessageCostDevelopment({ ...baseParams, webSearchCost: searchCost });
      const resultWithout = estimateMessageCostDevelopment(baseParams);

      expect(result).toBeCloseTo(resultWithout + applyFees(searchCost), 10);
    });

    it('defaults webSearchCost to 0 when omitted', () => {
      const withoutSearch = estimateMessageCostDevelopment(baseParams);
      const withZeroSearch = estimateMessageCostDevelopment({ ...baseParams, webSearchCost: 0 });
      expect(withoutSearch).toBe(withZeroSearch);
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

describe('calculateMessageCostFromActual', () => {
  const baseParams: MessageCostFromActualParams = {
    gatewayCost: 0.001, // $0.001 from the AI Gateway
    inputCharacters: 500,
    outputCharacters: 200,
  };

  describe('model cost with fees', () => {
    it('applies 15% fee to gateway exact cost', () => {
      const result = calculateMessageCostFromActual(baseParams);
      const expectedModelCostWithFees = applyFees(0.001);
      const expectedStorageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(expectedModelCostWithFees + expectedStorageFee, 10);
    });

    it('correctly calculates fee ratio as exactly 1.15x', () => {
      const paramsNoStorage: MessageCostFromActualParams = {
        gatewayCost: 0.01,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromActual(paramsNoStorage);

      expect(result / 0.01).toBeCloseTo(1 + TOTAL_FEE_RATE, 10);
    });

    it('handles zero gateway cost', () => {
      const zeroCostParams: MessageCostFromActualParams = {
        gatewayCost: 0,
        inputCharacters: 500,
        outputCharacters: 200,
      };
      const result = calculateMessageCostFromActual(zeroCostParams);
      const expectedStorageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(expectedStorageFee, 10);
    });

    it('handles very small gateway costs', () => {
      const smallCostParams: MessageCostFromActualParams = {
        gatewayCost: 0.000_000_1,
        inputCharacters: 10,
        outputCharacters: 10,
      };
      const result = calculateMessageCostFromActual(smallCostParams);

      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('storage fee calculation', () => {
    it('charges storage fee per character', () => {
      const paramsNoModelCost: MessageCostFromActualParams = {
        gatewayCost: 0,
        inputCharacters: 1000,
        outputCharacters: 1000,
      };
      const result = calculateMessageCostFromActual(paramsNoModelCost);

      expect(result).toBeCloseTo(2000 * STORAGE_COST_PER_CHARACTER, 10);
    });

    it('does not apply fees to storage cost', () => {
      const modelOnlyResult = calculateMessageCostFromActual({
        ...baseParams,
        inputCharacters: 0,
        outputCharacters: 0,
      });
      const fullResult = calculateMessageCostFromActual(baseParams);
      const storageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      // Full result should be model cost with fees + raw storage fee (no fees on storage)
      expect(fullResult).toBeCloseTo(modelOnlyResult + storageFee, 10);
    });

    it('handles zero characters', () => {
      const noCharsParams: MessageCostFromActualParams = {
        gatewayCost: 0.001,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromActual(noCharsParams);

      expect(result).toBeCloseTo(applyFees(0.001), 10);
    });
  });

  describe('combined calculation', () => {
    it('sums model cost with fees and storage fee', () => {
      const result = calculateMessageCostFromActual(baseParams);

      const modelCostWithFees = 0.001 * (1 + TOTAL_FEE_RATE);
      const storageFee = (500 + 200) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });

    it('returns correct result with real-world gateway cost', () => {
      // Typical GPT-4 response costing $0.05
      const realWorldParams: MessageCostFromActualParams = {
        gatewayCost: 0.05,
        inputCharacters: 4000,
        outputCharacters: 2000,
      };
      const result = calculateMessageCostFromActual(realWorldParams);

      const modelCostWithFees = 0.05 * (1 + TOTAL_FEE_RATE); // 0.0575
      const storageFee = (4000 + 2000) * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });

    it('handles large gateway costs', () => {
      const largeCostParams: MessageCostFromActualParams = {
        gatewayCost: 10, // $10 for expensive operation
        inputCharacters: 100_000,
        outputCharacters: 100_000,
      };
      const result = calculateMessageCostFromActual(largeCostParams);

      expect(result).toBeGreaterThan(10);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns 0 when all inputs are 0', () => {
      const zeroParams: MessageCostFromActualParams = {
        gatewayCost: 0,
        inputCharacters: 0,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromActual(zeroParams);

      expect(result).toBe(0);
    });

    it('handles input characters only', () => {
      const inputOnlyParams: MessageCostFromActualParams = {
        gatewayCost: 0.001,
        inputCharacters: 500,
        outputCharacters: 0,
      };
      const result = calculateMessageCostFromActual(inputOnlyParams);

      const modelCostWithFees = applyFees(0.001);
      const storageFee = 500 * STORAGE_COST_PER_CHARACTER;

      expect(result).toBeCloseTo(modelCostWithFees + storageFee, 10);
    });

    it('handles output characters only', () => {
      const outputOnlyParams: MessageCostFromActualParams = {
        gatewayCost: 0.001,
        inputCharacters: 0,
        outputCharacters: 200,
      };
      const result = calculateMessageCostFromActual(outputOnlyParams);

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

describe('effectiveOutputCostPerToken', () => {
  // Output is tokens→chars: inverted from input (chars→tokens).
  // Paid: CONSERVATIVE (2) = optimistic (less storage, cushion absorbs).
  // Free/trial/guest: STANDARD (4) = pessimistic (more storage budgeted).

  it('paid tier uses conservative (optimistic) storage estimate', () => {
    const modelPrice = 0.000_075; // Claude Opus-level
    const expected = modelPrice + CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER;
    expect(effectiveOutputCostPerToken(modelPrice, 'paid')).toBeCloseTo(expected, 15);
  });

  it('free tier uses standard (pessimistic) storage estimate', () => {
    const modelPrice = 0.000_075;
    const expected = modelPrice + CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER;
    expect(effectiveOutputCostPerToken(modelPrice, 'free')).toBeCloseTo(expected, 15);
  });

  it('trial tier uses standard (pessimistic) storage estimate', () => {
    const modelPrice = 0.000_01;
    const expected = modelPrice + CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER;
    expect(effectiveOutputCostPerToken(modelPrice, 'trial')).toBeCloseTo(expected, 15);
  });

  it('guest tier uses standard (pessimistic) storage estimate', () => {
    const modelPrice = 0.000_01;
    const expected = modelPrice + CHARS_PER_TOKEN_STANDARD * STORAGE_COST_PER_CHARACTER;
    expect(effectiveOutputCostPerToken(modelPrice, 'guest')).toBeCloseTo(expected, 15);
  });

  it('returns positive value for zero model price', () => {
    const result = effectiveOutputCostPerToken(0, 'paid');
    expect(result).toBeGreaterThan(0);
    expect(result).toBe(CHARS_PER_TOKEN_CONSERVATIVE * STORAGE_COST_PER_CHARACTER);
  });

  it('free tier has higher output cost than paid (pessimistic vs optimistic)', () => {
    const modelPrice = 0.000_01;
    const paidResult = effectiveOutputCostPerToken(modelPrice, 'paid');
    const freeResult = effectiveOutputCostPerToken(modelPrice, 'free');
    // Free uses 4 chars/token (pessimistic), paid uses 2 chars/token (optimistic)
    expect(freeResult).toBeGreaterThan(paidResult);
  });
});

describe('getModelPricing', () => {
  it('applies fees to input and output prices', () => {
    const result = getModelPricing(0.000_01, 0.000_03, 128_000);

    expect(result.inputPricePerToken).toBeCloseTo(applyFees(0.000_01), 15);
    expect(result.outputPricePerToken).toBeCloseTo(applyFees(0.000_03), 15);
  });

  it('passes through context length unchanged', () => {
    const result = getModelPricing(0.000_01, 0.000_03, 200_000);

    expect(result.contextLength).toBe(200_000);
  });

  it('handles zero prices', () => {
    const result = getModelPricing(0, 0, 128_000);

    expect(result.inputPricePerToken).toBe(0);
    expect(result.outputPricePerToken).toBe(0);
    expect(result.contextLength).toBe(128_000);
  });

  it('handles very small prices (auto-router cheapest)', () => {
    const result = getModelPricing(0.000_000_039, 0.000_000_19, 2_000_000);

    expect(result.inputPricePerToken).toBeCloseTo(applyFees(0.000_000_039), 15);
    expect(result.outputPricePerToken).toBeCloseTo(applyFees(0.000_000_19), 15);
    expect(result.contextLength).toBe(2_000_000);
  });

  it('returns fee-inclusive prices matching applyFees exactly', () => {
    // Verify the shared helper produces the same result as manual applyFees
    const inputPrice = 0.000_015;
    const outputPrice = 0.000_075;
    const result = getModelPricing(inputPrice, outputPrice, 200_000);

    expect(result.inputPricePerToken).toBe(applyFees(inputPrice));
    expect(result.outputPricePerToken).toBe(applyFees(outputPrice));
  });
});

describe('mediaStorageCost', () => {
  it('multiplies bytes by MEDIA_STORAGE_COST_PER_BYTE', () => {
    const bytes = 1_000_000;
    expect(mediaStorageCost(bytes)).toBe(bytes * MEDIA_STORAGE_COST_PER_BYTE);
  });

  it('returns 0 for 0 bytes', () => {
    expect(mediaStorageCost(0)).toBe(0);
  });

  it('returns positive value for small file', () => {
    expect(mediaStorageCost(100)).toBeGreaterThan(0);
  });

  it('scales linearly', () => {
    const small = mediaStorageCost(1000);
    const large = mediaStorageCost(2000);
    expect(large).toBeCloseTo(small * 2, 15);
  });
});

describe('calculateMediaGenerationCost', () => {
  describe('image pricing', () => {
    it('charges perImage × imageCount + fees + storage', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'image', perImage: 0.04 },
        sizeBytes: 1_000_000,
        imageCount: 1,
      });
      const expectedModelCost = applyFees(0.04 * 1);
      const expectedStorage = mediaStorageCost(1_000_000);
      expect(result).toBeCloseTo(expectedModelCost + expectedStorage, 10);
    });

    it('handles multiple images', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'image', perImage: 0.04 },
        sizeBytes: 3_000_000,
        imageCount: 3,
      });
      const expectedModelCost = applyFees(0.04 * 3);
      const expectedStorage = mediaStorageCost(3_000_000);
      expect(result).toBeCloseTo(expectedModelCost + expectedStorage, 10);
    });

    it('defaults imageCount to 1', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'image', perImage: 0.04 },
        sizeBytes: 1_000_000,
      });
      const expectedModelCost = applyFees(0.04 * 1);
      const expectedStorage = mediaStorageCost(1_000_000);
      expect(result).toBeCloseTo(expectedModelCost + expectedStorage, 10);
    });
  });

  describe('video pricing', () => {
    it('charges perSecond × duration + fees + storage', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'video', perSecond: 0.1 },
        sizeBytes: 5_000_000,
        durationSeconds: 6,
      });
      const expectedModelCost = applyFees(0.1 * 6);
      const expectedStorage = mediaStorageCost(5_000_000);
      expect(result).toBeCloseTo(expectedModelCost + expectedStorage, 10);
    });

    it('requires durationSeconds for video', () => {
      expect(() =>
        calculateMediaGenerationCost({
          pricing: { kind: 'video', perSecond: 0.1 },
          sizeBytes: 5_000_000,
        })
      ).toThrow('durationSeconds required');
    });
  });

  describe('audio pricing', () => {
    it('charges perSecond × duration + fees + storage', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'audio', perSecond: 0.015 },
        sizeBytes: 500_000,
        durationSeconds: 10,
      });
      const expectedModelCost = applyFees(0.015 * 10);
      const expectedStorage = mediaStorageCost(500_000);
      expect(result).toBeCloseTo(expectedModelCost + expectedStorage, 10);
    });

    it('requires durationSeconds for audio', () => {
      expect(() =>
        calculateMediaGenerationCost({
          pricing: { kind: 'audio', perSecond: 0.015 },
          sizeBytes: 500_000,
        })
      ).toThrow('durationSeconds required');
    });
  });

  describe('edge cases', () => {
    it('returns only storage cost when model cost is 0', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'image', perImage: 0 },
        sizeBytes: 1_000_000,
        imageCount: 1,
      });
      expect(result).toBe(mediaStorageCost(1_000_000));
    });

    it('returns only model cost when sizeBytes is 0', () => {
      const result = calculateMediaGenerationCost({
        pricing: { kind: 'image', perImage: 0.04 },
        sizeBytes: 0,
        imageCount: 1,
      });
      expect(result).toBeCloseTo(applyFees(0.04), 10);
    });
  });
});

describe('computeImageWorstCaseCents', () => {
  it('returns cents, fees applied to model cost, storage added', () => {
    const result = computeImageWorstCaseCents(0.04, 1);
    const expectedDollars = applyFees(0.04) + mediaStorageCost(ESTIMATED_IMAGE_BYTES);
    expect(result).toBeCloseTo(expectedDollars * 100, 5);
  });

  it('scales linearly with number of models', () => {
    const single = computeImageWorstCaseCents(0.04, 1);
    const triple = computeImageWorstCaseCents(0.04, 3);
    expect(triple).toBeCloseTo(single * 3, 5);
  });

  it('returns only storage when perImage is 0', () => {
    const result = computeImageWorstCaseCents(0, 1);
    expect(result).toBeCloseTo(mediaStorageCost(ESTIMATED_IMAGE_BYTES) * 100, 5);
  });

  it('returns 0 cents when both perImage and modelCount are 0', () => {
    expect(computeImageWorstCaseCents(0, 0)).toBe(0);
  });
});

describe('estimateVideoWorstCaseCents', () => {
  it('applies fees to perSecond × duration and adds storage for duration × bytes/sec', () => {
    const perSecond = 0.1;
    const durationSeconds = 4;
    const modelCount = 1;
    const expectedDollars =
      applyFees(perSecond * durationSeconds) +
      mediaStorageCost(durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND);
    const result = estimateVideoWorstCaseCents({ perSecond, durationSeconds, modelCount });
    expect(result).toBeCloseTo(expectedDollars * 100, 5);
  });

  it('scales linearly with model count', () => {
    const single = estimateVideoWorstCaseCents({
      perSecond: 0.1,
      durationSeconds: 4,
      modelCount: 1,
    });
    const quad = estimateVideoWorstCaseCents({
      perSecond: 0.1,
      durationSeconds: 4,
      modelCount: 4,
    });
    expect(quad).toBeCloseTo(single * 4, 5);
  });

  it('scales linearly with duration', () => {
    const short = estimateVideoWorstCaseCents({
      perSecond: 0.1,
      durationSeconds: 2,
      modelCount: 1,
    });
    const long = estimateVideoWorstCaseCents({
      perSecond: 0.1,
      durationSeconds: 8,
      modelCount: 1,
    });
    expect(long).toBeCloseTo(short * 4, 5);
  });

  it('returns only storage when perSecond is 0', () => {
    const result = estimateVideoWorstCaseCents({
      perSecond: 0,
      durationSeconds: 4,
      modelCount: 1,
    });
    expect(result).toBeCloseTo(mediaStorageCost(4 * ESTIMATED_VIDEO_BYTES_PER_SECOND) * 100, 5);
  });

  it('returns 0 cents when duration is 0', () => {
    expect(estimateVideoWorstCaseCents({ perSecond: 0.1, durationSeconds: 0, modelCount: 1 })).toBe(
      0
    );
  });
});

describe('computeImageExactCents', () => {
  it('returns 0 when the price list is empty', () => {
    expect(computeImageExactCents([])).toBe(0);
  });

  it('sums per-model prices with fees and per-model storage', () => {
    const prices = [0.02, 0.06];
    const expectedDollars = applyFees(0.02 + 0.06) + mediaStorageCost(ESTIMATED_IMAGE_BYTES) * 2;
    expect(computeImageExactCents(prices)).toBeCloseTo(expectedDollars * 100, 5);
  });

  it('does not use the max — a mixed pool costs less than count × max', () => {
    const mixed = computeImageExactCents([0.02, 0.06]);
    const maxOnly = computeImageExactCents([0.06, 0.06]);
    expect(mixed).toBeLessThan(maxOnly);
  });

  it('single-model case equals worst-case for the same price', () => {
    expect(computeImageExactCents([0.04])).toBeCloseTo(computeImageWorstCaseCents(0.04, 1), 5);
  });

  it('treats a zero-price entry as only its storage cost', () => {
    const result = computeImageExactCents([0]);
    expect(result).toBeCloseTo(mediaStorageCost(ESTIMATED_IMAGE_BYTES) * 100, 5);
  });
});

describe('computeVideoExactCents', () => {
  it('returns 0 when the price list is empty', () => {
    expect(computeVideoExactCents([], 4)).toBe(0);
  });

  it('returns 0 when duration is 0', () => {
    expect(computeVideoExactCents([0.1, 0.4], 0)).toBe(0);
  });

  it('sums per-model (perSecond × duration) with fees and per-model storage', () => {
    const prices = [0.1, 0.4];
    const duration = 4;
    const expectedDollars =
      applyFees((0.1 + 0.4) * duration) +
      mediaStorageCost(duration * ESTIMATED_VIDEO_BYTES_PER_SECOND) * 2;
    expect(computeVideoExactCents(prices, duration)).toBeCloseTo(expectedDollars * 100, 5);
  });

  it('does not use the max — a mixed pool costs less than count × max', () => {
    const mixed = computeVideoExactCents([0.1, 0.4], 4);
    const maxOnly = computeVideoExactCents([0.4, 0.4], 4);
    expect(mixed).toBeLessThan(maxOnly);
  });

  it('single-model case equals worst-case for the same price', () => {
    const single = computeVideoExactCents([0.1], 4);
    const worst = estimateVideoWorstCaseCents({
      perSecond: 0.1,
      durationSeconds: 4,
      modelCount: 1,
    });
    expect(single).toBeCloseTo(worst, 5);
  });

  it('scales linearly with duration', () => {
    const short = computeVideoExactCents([0.1], 2);
    const long = computeVideoExactCents([0.1], 8);
    expect(long).toBeCloseTo(short * 4, 5);
  });
});
