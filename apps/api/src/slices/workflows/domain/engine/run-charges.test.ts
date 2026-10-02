import { describe, expect, it } from 'vitest';
import { collectCharge } from './run-charges.js';
import type { NodeRunSuccess } from './execution-registry.js';
import type { SettlementCharge } from '@hushbox/shared';

function textSuccess(overrides: Partial<NodeRunSuccess> = {}): NodeRunSuccess {
  return {
    value: 'answer',
    costNanoUsd: 1000n,
    billing: { modelId: 'vendor/model', providerName: 'vendor', modality: 'text' },
    ...overrides,
  };
}

describe('collectCharge', () => {
  it('collects nothing for an execution that carries no billing facts', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(charges, 'node', { value: 'transformed', costNanoUsd: 0n });
    expect(charges).toEqual([]);
  });

  it('keys the primary charge by the node key', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(charges, 'node', textSuccess());
    expect(charges).toEqual([
      {
        key: 'node',
        modelId: 'vendor/model',
        providerName: 'vendor',
        modality: 'text',
        billableCostNanoUsd: 1000n,
        isEstimated: false,
      },
    ]);
  });

  it('badges the primary charge when the routing pipeline ran', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(charges, 'node', textSuccess({ smartModelRan: true }));
    expect(charges[0]).toMatchObject({ smartModelRan: true });
  });

  it('carries the estimated flag through from the execution', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(charges, 'node', textSuccess({ isEstimated: true }));
    expect(charges[0]).toMatchObject({ isEstimated: true });
  });

  it('carries the optional billing dimensions through to the charge', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(
      charges,
      'node',
      textSuccess({
        billing: {
          modelId: 'vendor/model',
          providerName: 'vendor',
          modality: 'text',
          generationId: 'generation',
          tokens: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 1, reasoningTokens: 0 },
          reasoningEffort: 'off',
        },
      })
    );
    expect(charges[0]).toMatchObject({
      generationId: 'generation',
      tokens: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 1, reasoningTokens: 0 },
      reasoningEffort: 'off',
    });
  });

  it('carries the reasoning time through to the charge', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(
      charges,
      'node',
      textSuccess({
        billing: {
          modelId: 'vendor/model',
          providerName: 'vendor',
          modality: 'text',
          reasoningDurationMs: 3200,
        },
      })
    );
    expect(charges[0]).toMatchObject({ reasoningDurationMs: 3200 });
  });

  it('carries no reasoning time for a generation that showed none', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(charges, 'node', textSuccess());
    expect(charges[0]).not.toHaveProperty('reasoningDurationMs');
  });

  it('carries the media dimension through for a media generation', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(
      charges,
      'node',
      textSuccess({
        billing: {
          modelId: 'vendor/image',
          providerName: 'vendor',
          modality: 'image',
          media: { imageCount: 2 },
        },
      })
    );
    expect(charges[0]).toMatchObject({ modality: 'image', media: { imageCount: 2 } });
  });

  it('suffixes an auxiliary generation so its key never collides with the node key', () => {
    const charges: SettlementCharge[] = [];
    collectCharge(
      charges,
      'node',
      textSuccess({
        auxiliaryCharges: [
          {
            keySuffix: 'aux',
            billing: { modelId: 'vendor/aux', providerName: 'vendor', modality: 'text' },
            billableCostNanoUsd: 25n,
            isEstimated: true,
          },
        ],
      })
    );
    expect(charges.map((charge) => charge.key)).toEqual(['node', 'node#aux']);
    expect(charges[1]).toMatchObject({ billableCostNanoUsd: 25n, isEstimated: true });
  });
});
