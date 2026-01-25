import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Model } from '@lome-chat/shared';
import { useModelValidation } from './use-model-validation.js';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('./billing.js', () => ({
  useBalance: vi.fn(),
}));

vi.mock('./models.js', () => ({
  useModels: vi.fn(),
  getAccessibleModelIds: vi.fn(),
}));

vi.mock('@/stores/model', () => ({
  useModelStore: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useBalance } from './billing.js';
import { useModels, getAccessibleModelIds } from './models.js';
import { useModelStore } from '@/stores/model';

const mockedUseSession = vi.mocked(useSession);
const mockedUseBalance = vi.mocked(useBalance);
const mockedUseModels = vi.mocked(useModels);
const mockedGetAccessibleModelIds = vi.mocked(getAccessibleModelIds);
const mockedUseModelStore = vi.mocked(useModelStore);

// Test models
const testModels: Model[] = [
  {
    id: 'basic-model',
    name: 'Basic Model',
    description: 'A basic model',
    provider: 'TestProvider',
    contextLength: 100_000,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
  },
  {
    id: 'premium-model',
    name: 'Premium Model',
    description: 'A premium model',
    provider: 'TestProvider',
    contextLength: 200_000,
    pricePerInputToken: 0.0001,
    pricePerOutputToken: 0.0003,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
  },
];

describe('useModelValidation', () => {
  const mockSetSelectedModel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock setup: guest user (session loaded with no user, no balance)
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);

    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'basic-model',
      selectedModelName: 'Basic Model',
      setSelectedModel: mockSetSelectedModel,
    });

    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when models data is not loaded', () => {
    // Guest user (session loaded with no user)
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({ data: undefined } as ReturnType<typeof useModels>);

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it('does not reset model while session is loading', () => {
    // Session still loading - we don't know if user is authenticated yet
    // This is the key bug fix: without isPending check, we'd treat loading user as guest
    mockedUseSession.mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model',
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    // Should NOT reset - we don't know if user is authenticated yet
    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it('does nothing when user can access premium', () => {
    // Paid user with positive balance
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '10.00', freeAllowanceCents: 0 },
    } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model', // Premium model selected
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it('does nothing when selected model is already accessible', () => {
    // Free user (authenticated but zero balance)
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '0.00', freeAllowanceCents: 100 },
    } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'basic-model', // Basic model (accessible)
      selectedModelName: 'Basic Model',
      setSelectedModel: mockSetSelectedModel,
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it('resets model when free user has premium model selected', () => {
    // Free user (authenticated but zero balance)
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '0.00', freeAllowanceCents: 100 },
    } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model', // Premium model selected (not accessible)
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).toHaveBeenCalledWith('basic-model', 'Basic Model');
  });

  it('resets model when guest user has premium model selected', () => {
    // Guest user (session loaded with no user)
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model', // Premium model selected (not accessible)
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).toHaveBeenCalledWith('basic-model', 'Basic Model');
  });

  it('uses correct strongest model for reset', () => {
    const modelsWithMultipleBasic: Model[] = [
      ...testModels,
      {
        id: 'expensive-basic',
        name: 'Expensive Basic',
        description: 'An expensive basic model',
        provider: 'TestProvider',
        contextLength: 150_000,
        pricePerInputToken: 0.000_05,
        pricePerOutputToken: 0.000_15,
        capabilities: [],
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
      },
    ];

    // Guest user (session loaded with no user)
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: modelsWithMultipleBasic,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model',
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'expensive-basic', // The strongest basic model
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).toHaveBeenCalledWith('expensive-basic', 'Expensive Basic');
  });

  it('does not reset if strongest model is not found in models list', () => {
    // Guest user (session loaded with no user)
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model',
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'non-existent-model', // Model not in list
      valueId: 'non-existent-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it('does not reset model while balance is loading for authenticated user', () => {
    // Authenticated user with balance still loading (undefined)
    // Session is loaded (user is authenticated), but balance still loading
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: undefined, // Balance still loading
    } as ReturnType<typeof useBalance>);
    mockedUseModels.mockReturnValue({
      data: {
        models: testModels,
        premiumIds: new Set(['premium-model']),
      },
    } as ReturnType<typeof useModels>);
    mockedUseModelStore.mockReturnValue({
      selectedModelId: 'premium-model', // Premium model from cache
      selectedModelName: 'Premium Model',
      setSelectedModel: mockSetSelectedModel,
    });
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    // Should NOT reset - wait for balance to load first
    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });
});
