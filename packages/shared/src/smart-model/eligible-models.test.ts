import { describe, expect, it } from 'vitest';

import type { Model } from '../schemas/api/models.js';

import {
  buildEligibleModels,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  CLASSIFIER_PROMPT_OVERHEAD_CHARS,
} from './eligible-models.js';

function makeTextModel(overrides: Partial<Model> & { id: string; name: string }): Model {
  return {
    description: 'description',
    provider: 'TestProvider',
    modality: 'text',
    contextLength: 200_000,
    pricePerInputToken: 0.000_001,
    pricePerOutputToken: 0.000_005,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: [],
    ...overrides,
  };
}

const PAID_BALANCE_CENTS = 1000; // $10
const FREE_ALLOWANCE_CENTS = 0;
const PROMPT_CHAR_COUNT = 200;

describe('buildEligibleModels constants', () => {
  it('exposes a non-zero classifier output token cap', () => {
    expect(CLASSIFIER_OUTPUT_TOKEN_CAP).toBeGreaterThan(0);
  });

  it('reserves overhead chars for the classifier system prompt and model list', () => {
    expect(CLASSIFIER_PROMPT_OVERHEAD_CHARS).toBeGreaterThan(0);
  });
});

describe('buildEligibleModels', () => {
  it('returns null when there are no text models', () => {
    expect(
      buildEligibleModels({
        textModels: [],
        premiumIds: new Set(),
        payerTier: 'paid',
        payerBalanceCents: PAID_BALANCE_CENTS,
        payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
        promptCharacterCount: PROMPT_CHAR_COUNT,
      })
    ).toBeNull();
  });

  it('picks the cheapest non-premium text model as the classifier', () => {
    const models = [
      makeTextModel({
        id: 'expensive/x',
        name: 'X',
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_05,
      }),
      makeTextModel({
        id: 'cheap/c',
        name: 'C',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'mid/m',
        name: 'M',
        pricePerInputToken: 0.000_005,
        pricePerOutputToken: 0.000_025,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierModelId).toBe('cheap/c');
  });

  it('excludes premium models for non-paid users', () => {
    const models = [
      makeTextModel({
        id: 'cheap/free',
        name: 'F',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'premium/p',
        name: 'P',
        pricePerInputToken: 0.000_002,
        pricePerOutputToken: 0.000_01,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(['premium/p']),
      payerTier: 'free',
      payerBalanceCents: 0,
      payerFreeAllowanceCents: 5,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.eligibleInferenceIds).toContain('cheap/free');
    expect(result?.eligibleInferenceIds).not.toContain('premium/p');
  });

  it('includes premium models for paid users', () => {
    const models = [
      makeTextModel({
        id: 'cheap/free',
        name: 'F',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'premium/p',
        name: 'P',
        pricePerInputToken: 0.000_002,
        pricePerOutputToken: 0.000_01,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(['premium/p']),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.eligibleInferenceIds).toContain('premium/p');
  });

  it('drops candidates whose worst-case inference plus classifier cost exceeds the budget', () => {
    const models = [
      makeTextModel({
        id: 'cheap/c',
        name: 'C',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
      makeTextModel({
        id: 'tooexpensive/x',
        name: 'X',
        pricePerInputToken: 0.001,
        pricePerOutputToken: 0.005,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: 50, // tight budget
      payerFreeAllowanceCents: 0,
      promptCharacterCount: 100,
    });
    expect(result?.eligibleInferenceIds).toContain('cheap/c');
    expect(result?.eligibleInferenceIds).not.toContain('tooexpensive/x');
  });

  it('returns null when no candidate is affordable even with classifier overhead', () => {
    const models = [
      makeTextModel({
        id: 'expensive/e',
        name: 'E',
        pricePerInputToken: 1,
        pricePerOutputToken: 1,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: 1, // 1 cent
      payerFreeAllowanceCents: 0,
      promptCharacterCount: 100,
    });
    expect(result).toBeNull();
  });

  it('includes the classifier itself in eligibleInferenceIds when affordable', () => {
    const models = [
      makeTextModel({
        id: 'only/c',
        name: 'C',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierModelId).toBe('only/c');
    expect(result?.eligibleInferenceIds).toEqual(['only/c']);
  });

  it('reports a positive classifier worst-case cents', () => {
    const result = buildEligibleModels({
      textModels: [
        makeTextModel({
          id: 'cheap/c',
          name: 'C',
          pricePerInputToken: 0.000_001,
          pricePerOutputToken: 0.000_005,
        }),
      ],
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierWorstCaseCents).toBeGreaterThan(0);
  });

  it('skips models flagged as Smart Model in the input', () => {
    const models = [
      makeTextModel({ id: 'smart-model', name: 'Smart', isSmartModel: true }),
      makeTextModel({
        id: 'real/r',
        name: 'R',
        pricePerInputToken: 0.000_001,
        pricePerOutputToken: 0.000_005,
      }),
    ];
    const result = buildEligibleModels({
      textModels: models,
      premiumIds: new Set(),
      payerTier: 'paid',
      payerBalanceCents: PAID_BALANCE_CENTS,
      payerFreeAllowanceCents: FREE_ALLOWANCE_CENTS,
      promptCharacterCount: PROMPT_CHAR_COUNT,
    });
    expect(result?.classifierModelId).toBe('real/r');
    expect(result?.eligibleInferenceIds).not.toContain('smart-model');
  });
});
