import { describe, it, expect } from 'vitest';
import { PREMIUM_PRICE_PERCENTILE, PREMIUM_RECENCY_MS, isPremiumModel } from './premium-check.js';
import type { OpenRouterModel } from '../models.js';

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
  const createModel = (overrides: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
    id: 'test/model',
    name: 'Test Model',
    description: 'A test model',
    context_length: 8192,
    pricing: { prompt: '0.001', completion: '0.002' },
    supported_parameters: [],
    created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // 400 days ago
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
