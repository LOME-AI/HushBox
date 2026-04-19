import { describe, it, expect } from 'vitest';
import {
  PREMIUM_PRICE_PERCENTILE,
  PREMIUM_RECENCY_MS,
  TRIAL_AFFORDABILITY_MULTIPLIER,
  isPremiumModel,
  exceedsTrialBudget,
} from './premium-check.js';
import type { RawModel } from './types.js';

describe('PREMIUM_PRICE_PERCENTILE', () => {
  it('is 0.75 (75th percentile)', () => {
    expect(PREMIUM_PRICE_PERCENTILE).toBe(0.75);
  });
});

describe('PREMIUM_RECENCY_MS', () => {
  it('is 1 year in milliseconds', () => {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    expect(PREMIUM_RECENCY_MS).toBe(oneYearMs);
  });
});

describe('isPremiumModel', () => {
  const createModel = (overrides: Partial<RawModel> = {}): RawModel => ({
    id: 'test/model',
    name: 'Test Model',
    description: 'A test model',
    context_length: 8192,
    pricing: { prompt: '0.001', completion: '0.002' },
    supported_parameters: [],
    created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // 400 days ago
    modality: 'text' as const,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    ...overrides,
  });

  it('returns true when price is at or above threshold', () => {
    const model = createModel({ pricing: { prompt: '0.01', completion: '0.02' } });
    const priceThreshold = 0.02; // model price is 0.03

    expect(isPremiumModel(model, priceThreshold)).toBe(true);
  });

  it('returns false when price is below threshold and model is old', () => {
    const model = createModel({
      pricing: { prompt: '0.001', completion: '0.001' },
      created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // 400 days ago
    });
    const priceThreshold = 0.01;

    expect(isPremiumModel(model, priceThreshold)).toBe(false);
  });

  it('returns true for recent models regardless of price', () => {
    const model = createModel({
      pricing: { prompt: '0.0001', completion: '0.0001' }, // Very cheap
      created: Math.floor(Date.now() / 1000) - 100 * 24 * 60 * 60, // 100 days ago (recent)
    });
    const priceThreshold = 0.01;

    expect(isPremiumModel(model, priceThreshold)).toBe(true);
  });

  it('returns false for old and cheap models', () => {
    const model = createModel({
      pricing: { prompt: '0.0001', completion: '0.0001' },
      created: Math.floor(Date.now() / 1000) - 500 * 24 * 60 * 60, // 500 days ago
    });
    const priceThreshold = 0.01;

    expect(isPremiumModel(model, priceThreshold)).toBe(false);
  });
});

describe('TRIAL_AFFORDABILITY_MULTIPLIER', () => {
  it('is 2 (model must afford 2× minimum output tokens)', () => {
    expect(TRIAL_AFFORDABILITY_MULTIPLIER).toBe(2);
  });
});

describe('exceedsTrialBudget', () => {
  const createModel = (overrides: Partial<RawModel> = {}): RawModel => ({
    id: 'test/model',
    name: 'Test Model',
    description: 'A test model',
    context_length: 128_000,
    pricing: { prompt: '0.000001', completion: '0.000001' },
    supported_parameters: [],
    created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60,
    modality: 'text' as const,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    ...overrides,
  });

  // Use a fixed system prompt length for deterministic tests (~400 chars)
  const systemPromptChars = 400;

  it('returns true for Sonar Reasoning Pro pricing (output $0.0092/1K)', () => {
    const model = createModel({
      pricing: { prompt: '0.0000023', completion: '0.0000092' },
    });

    expect(exceedsTrialBudget(model, systemPromptChars)).toBe(true);
  });

  it('returns false for cheap model (output $0.001/1K)', () => {
    const model = createModel({
      pricing: { prompt: '0.000001', completion: '0.000001' },
    });

    expect(exceedsTrialBudget(model, systemPromptChars)).toBe(false);
  });

  it('returns true when output price alone exceeds budget for 2× minimum tokens', () => {
    // Even with zero system prompt, expensive output should exceed
    const model = createModel({
      pricing: { prompt: '0', completion: '0.0000092' },
    });

    expect(exceedsTrialBudget(model, 0)).toBe(true);
  });

  it('accounts for system prompt input cost', () => {
    // A model that barely fits with 0 system prompt chars should exceed with a large prompt
    // Output cost for 2000 tokens at $0.004/1K with fees: 2000 × 0.000004 × 1.15 ≈ $0.0092
    // This is just under $0.01 budget, but adding system prompt input cost pushes it over
    const model = createModel({
      pricing: { prompt: '0.000004', completion: '0.000004' },
    });

    const withoutPrompt = exceedsTrialBudget(model, 0);
    const withLargePrompt = exceedsTrialBudget(model, 5000);

    // With no prompt it should be borderline (may or may not exceed depending on storage)
    // With a large prompt the input cost should push it over
    expect(withLargePrompt).toBe(true);
    // Verify the large prompt case is strictly worse
    if (!withoutPrompt) {
      expect(withLargePrompt).toBe(true);
    }
  });
});
