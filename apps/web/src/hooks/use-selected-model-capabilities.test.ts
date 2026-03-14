import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Model } from '@hushbox/shared';
import { useSelectedModelCapabilities } from './use-selected-model-capabilities.js';

vi.mock('@/stores/model', () => ({
  useModelStore: vi.fn(),
  getPrimaryModel: vi.fn(),
}));

vi.mock('@/hooks/models', () => ({
  useModels: vi.fn(),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    modelSupportsCapability: vi.fn(),
  };
});

import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { modelSupportsCapability } from '@hushbox/shared';

const mockedUseModelStore = vi.mocked(useModelStore);
const mockedGetPrimaryModel = vi.mocked(getPrimaryModel);
const mockedUseModels = vi.mocked(useModels);
const mockedModelSupportsCapability = vi.mocked(modelSupportsCapability);

const testModel: Model = {
  id: 'test-model',
  name: 'Test Model',
  description: 'A test model',
  provider: 'TestProvider',
  contextLength: 100_000,
  pricePerInputToken: 0.000_01,
  pricePerOutputToken: 0.000_03,
  capabilities: [],
  supportedParameters: ['web_search'],
  created: Math.floor(Date.now() / 1000),
};

const testModelNoSearch: Model = {
  id: 'no-search-model',
  name: 'No Search Model',
  description: 'A model without search',
  provider: 'TestProvider',
  contextLength: 100_000,
  pricePerInputToken: 0.000_01,
  pricePerOutputToken: 0.000_03,
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
    mockedModelSupportsCapability.mockReturnValue(false);

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
    expect(result.current.supportsSearch).toBe(false);
  });

  it('finds the selected model from the models list', () => {
    mockedUseModels.mockReturnValue({
      data: { models: [testModel, testModelNoSearch], premiumIds: new Set() },
    } as ReturnType<typeof useModels>);
    mockedModelSupportsCapability.mockReturnValue(false);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.selectedModel).toBe(testModel);
  });

  it('returns supportsSearch true when model supports web-search', () => {
    mockedUseModels.mockReturnValue({
      data: { models: [testModel], premiumIds: new Set() },
    } as ReturnType<typeof useModels>);
    mockedModelSupportsCapability.mockReturnValue(true);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.supportsSearch).toBe(true);
    expect(mockedModelSupportsCapability).toHaveBeenCalledWith(testModel, 'web-search');
  });

  it('returns supportsSearch false when model does not support web-search', () => {
    mockedGetPrimaryModel.mockReturnValue({ id: 'no-search-model', name: 'No Search Model' });
    mockedUseModels.mockReturnValue({
      data: { models: [testModelNoSearch], premiumIds: new Set() },
    } as ReturnType<typeof useModels>);
    mockedModelSupportsCapability.mockReturnValue(false);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.supportsSearch).toBe(false);
  });

  it('returns supportsSearch false when selected model is not found', () => {
    mockedGetPrimaryModel.mockReturnValue({ id: 'missing-model', name: 'Missing' });
    mockedUseModels.mockReturnValue({
      data: { models: [testModel], premiumIds: new Set() },
    } as ReturnType<typeof useModels>);

    const { result } = renderHook(() => useSelectedModelCapabilities());

    expect(result.current.selectedModel).toBeUndefined();
    expect(result.current.supportsSearch).toBe(false);
    expect(mockedModelSupportsCapability).not.toHaveBeenCalled();
  });
});
