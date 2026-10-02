import { describe, it, expect } from 'vitest';
import { calculateMonthlyCost } from './calculate-cost';
import type { Model } from '@hushbox/shared';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test/model',
    name: 'Test Model',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 128_000,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
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
        pricing: { inputPerToken: '10000000', outputPerToken: '30000000' },
      }),
      makeModel({
        id: 'cheap/model',
        name: 'Cheap',
        pricing: { inputPerToken: '1000', outputPerToken: '2000' },
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

  it('prices the wire-billable rates as-is: token sum plus storage, no fee applied', () => {
    // The wire pricing is billable (fees baked at catalog ingestion), so the
    // calculator is a pure sum: tokens × billable rates + chars × storage. Both
    // legs convert at 3 characters per token: 700 input characters (a 500-char
    // system prompt and a 200-char message) are 234 tokens, and the 400-char
    // reply is 134. Per message: 234 × 10,000 + 134 × 20,000 + 1,100 × 300 =
    // 5,350,000 nano; over 1,500 messages a month, $8.025.
    const model = makeModel({ pricing: { inputPerToken: '10000', outputPerToken: '20000' } });
    expect(calculateMonthlyCost([model]).monthlyCost).toBe(8.025);
  });

  it('returns cost for 50 messages per day over 30 days', () => {
    const model = makeModel({
      pricing: { inputPerToken: '10000', outputPerToken: '10000' },
    });
    const result = calculateMonthlyCost([model]);
    expect(result.messagesPerDay).toBe(50);
    expect(result.daysPerMonth).toBe(30);
  });

  it('skips free models (no token pricing)', () => {
    const models = [
      makeModel({ id: 'free/model', name: 'Free', pricing: {} }),
      makeModel({
        id: 'paid/model',
        name: 'Paid',
        pricing: { inputPerToken: '1000', outputPerToken: '2000' },
      }),
    ];
    const result = calculateMonthlyCost(models);
    expect(result.modelName).toBe('Paid');
  });

  it('returns zero when only free models exist', () => {
    const models = [makeModel({ pricing: {} })];
    const result = calculateMonthlyCost(models);
    expect(result.monthlyCost).toBe(0);
  });

  it('skips a model serving only an input rate, which prices nothing', () => {
    const models = [
      makeModel({ id: 'half/model', name: 'Half', pricing: { inputPerToken: '1' } }),
      makeModel({ id: 'paid/model', name: 'Paid' }),
    ];
    expect(calculateMonthlyCost(models).modelName).toBe('Paid');
  });

  it('skips a model serving only an output rate, which prices nothing', () => {
    const models = [
      makeModel({ id: 'half/model', name: 'Half', pricing: { outputPerToken: '1' } }),
      makeModel({ id: 'paid/model', name: 'Paid' }),
    ];
    expect(calculateMonthlyCost(models).modelName).toBe('Paid');
  });

  it('prices the first step of a long-context model at its base rates', () => {
    // 234 prompt tokens sit far below any long-context threshold, so the dearer
    // tier never applies: the figure is the untiered model's, $8.025.
    const tiered = makeModel({
      pricing: {
        inputPerToken: '10000',
        outputPerToken: '20000',
        longContextRates: [
          { abovePromptTokens: 200_000, inputPerToken: '90000', outputPerToken: '90000' },
        ],
      },
    });
    expect(calculateMonthlyCost([tiered]).monthlyCost).toBe(8.025);
  });

  it('returns a result with all expected fields', () => {
    const result = calculateMonthlyCost([makeModel()]);
    expect(result).toHaveProperty('monthlyCost');
    expect(result).toHaveProperty('modelName');
    expect(result).toHaveProperty('messagesPerDay');
    expect(result).toHaveProperty('daysPerMonth');
  });
});
