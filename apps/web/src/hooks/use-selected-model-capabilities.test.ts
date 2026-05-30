import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSelectedModelCapabilities } from './use-selected-model-capabilities.js';
import type { Model } from '@hushbox/shared';

vi.mock('@/stores/model', () => ({
  useModelStore: vi.fn(),
  getPrimaryModel: vi.fn(),
}));

vi.mock('@/hooks/models', () => ({
  useModels: vi.fn(),
}));

import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useModels } from '@/hooks/models';

const mockedUseModelStore = vi.mocked(useModelStore);
const mockedGetPrimaryModel = vi.mocked(getPrimaryModel);
const mockedUseModels = vi.mocked(useModels);

const testModel: Model = {
  id: 'test-model',
  name: 'Test Model',
  description: 'A test model',
  provider: 'TestProvider',
  modality: 'text' as const,
  contextLength: 100_000,
  pricePerInputToken: 0.000_01,
  pricePerOutputToken: 0.000_03,
  pricePerImage: 0,
  pricePerSecondByResolution: {},
  pricePerSecond: 0,
  capabilities: [],
  supportedParameters: [],
  created: Math.floor(Date.now() / 1000),
};

const testModelAlt: Model = {
  id: 'alt-model',
  name: 'Alt Model',
  description: 'Another model',
  provider: 'TestProvider',
  modality: 'text' as const,
  contextLength: 100_000,
  pricePerInputToken: 0.000_01,
  pricePerOutputToken: 0.000_03,
  pricePerImage: 0,
  pricePerSecondByResolution: {},
  pricePerSecond: 0,
  capabilities: [],
  supportedParameters: [],
  created: Math.floor(Date.now() / 1000),
};

describe('useSelectedModelCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseModelStore.mockReturnValue({
      selectedModels: [{ id: 'test-model', name: 'Test Model' }],
    } as ReturnType<typeof useModelStore>);
    mockedGetPrimaryModel.mockReturnValue({ id: 'test-model', name: 'Test Model' });
  });

  it('returns models and premiumIds from useModels', () => {
    const premiumIds = new Set(['premium-1']);
    mockedUseModels.mockReturnValue({
      data: { models: [testModel], premiumIds },
    } as ReturnType<typeof useModels>);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.models).toEqual([testModel]);
    expect(result.current.premiumIds).toBe(premiumIds);
  });

  it('returns empty models when modelsData is undefined', () => {
    mockedUseModels.mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useModels>);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.models).toEqual([]);
    expect(result.current.premiumIds).toEqual(new Set());
    expect(result.current.selectedModel).toBeUndefined();
  });

  it('finds the selected model from the models list', () => {
    mockedUseModels.mockReturnValue({
      data: { models: [testModel, testModelAlt], premiumIds: new Set() },
    } as ReturnType<typeof useModels>);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.selectedModel).toBe(testModel);
  });

  it('returns undefined selectedModel when primary model is not found', () => {
    mockedGetPrimaryModel.mockReturnValue({ id: 'missing-model', name: 'Missing' });
    mockedUseModels.mockReturnValue({
      data: { models: [testModel], premiumIds: new Set() },
    } as ReturnType<typeof useModels>);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.selectedModel).toBeUndefined();
  });
});
