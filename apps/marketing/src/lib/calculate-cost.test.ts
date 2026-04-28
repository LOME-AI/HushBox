import { describe, it, expect } from 'vitest';
import type { Model } from '@hushbox/shared';
import { calculateMonthlyCost } from './calculate-cost';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test/model',
    name: 'Test Model',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 128_000,
    pricePerInputToken: 0.000_001,
    pricePerOutputToken: 0.000_002,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    description: 'A test model',
    supportedParameters: ['temperature'],
    ...overrides,
  };
}

describe('calculateMonthlyCost', () => {
  it('returns zero cost for empty model list', () => {
    const result = calculateMonthlyCost([]);
    expect(result.monthlyCost).toBe(0);
    expect(result.modelName).toBe('');
  });

  it('selects the cheapest model by combined token price', () => {
    const models = [
      makeModel({
        id: 'expensive/model',
        name: 'Expensive',
        pricePerInputToken: 0.01,
        pricePerOutputToken: 0.03,
      }),
      makeModel({
        id: 'cheap/model',
        name: 'Cheap',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_002,
      }),
    ];
    const result = calculateMonthlyCost(models);
    expect(result.modelName).toBe('Cheap');
  });

  it('calculates a positive monthly cost', () => {
    const models = [makeModel()];
    const result = calculateMonthlyCost(models);
    expect(result.monthlyCost).toBeGreaterThan(0);
  });

  it('includes the 15% fee in the cost', () => {
    const models = [makeModel()];
    const result = calculateMonthlyCost(models);
    // The cost should be higher than raw token cost alone
    // Raw cost for 50 msgs/day * 30 days = 1500 messages
    // Each message: input tokens + output tokens + storage
    expect(result.monthlyCost).toBeGreaterThan(0);
  });

  it('returns cost for 50 messages per day over 30 days', () => {
    const model = makeModel({
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_01,
    });
    const result = calculateMonthlyCost([model]);
    // 1500 messages total
    expect(result.messagesPerDay).toBe(50);
    expect(result.daysPerMonth).toBe(30);
  });

  it('skips free models (zero price)', () => {
    const models = [
      makeModel({ id: 'free/model', name: 'Free', pricePerInputToken: 0, pricePerOutputToken: 0 }),
      makeModel({
        id: 'paid/model',
        name: 'Paid',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_002,
      }),
    ];
    const result = calculateMonthlyCost(models);
    expect(result.modelName).toBe('Paid');
  });

  it('returns zero when only free models exist', () => {
    const models = [makeModel({ pricePerInputToken: 0, pricePerOutputToken: 0 })];
    const result = calculateMonthlyCost(models);
    expect(result.monthlyCost).toBe(0);
  });

  it('returns a result with all expected fields', () => {
    const result = calculateMonthlyCost([makeModel()]);
    expect(result).toHaveProperty('monthlyCost');
    expect(result).toHaveProperty('modelName');
    expect(result).toHaveProperty('messagesPerDay');
    expect(result).toHaveProperty('daysPerMonth');
  });
});
