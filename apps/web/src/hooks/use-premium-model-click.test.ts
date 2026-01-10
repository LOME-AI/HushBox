import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePremiumModelClick } from './use-premium-model-click';
import { useUIModalsStore } from '@/stores/ui-modals';
import type { Model } from '@lome-chat/shared';

vi.mock('@/stores/ui-modals', () => ({
  useUIModalsStore: vi.fn(),
}));

const mockModels: Model[] = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    description: 'Premium model',
    provider: 'OpenAI',
    contextLength: 128000,
    pricePerInputToken: 0.00003,
    pricePerOutputToken: 0.00006,
    capabilities: ['streaming'],
    supportedParameters: [],
    created: Date.now() / 1000,
  },
  {
    id: 'llama-3',
    name: 'Llama 3',
    description: 'Basic model',
    provider: 'Meta',
    contextLength: 8192,
    pricePerInputToken: 0.0000001,
    pricePerOutputToken: 0.0000001,
    capabilities: ['streaming'],
    supportedParameters: [],
    created: Date.now() / 1000,
  },
];

describe('usePremiumModelClick', () => {
  const mockOpenSignupModal = vi.fn();
  const mockOpenPaymentModal = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUIModalsStore).mockReturnValue({
      openSignupModal: mockOpenSignupModal,
      openPaymentModal: mockOpenPaymentModal,
      signupModalOpen: false,
      paymentModalOpen: false,
      premiumModelName: undefined,
      setSignupModalOpen: vi.fn(),
      setPaymentModalOpen: vi.fn(),
    });
  });

  it('returns a function', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));
    expect(typeof result.current).toBe('function');
  });

  it('opens payment modal for authenticated user', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));

    result.current('gpt-4');

    expect(mockOpenPaymentModal).toHaveBeenCalledWith('GPT-4');
    expect(mockOpenSignupModal).not.toHaveBeenCalled();
  });

  it('opens signup modal for unauthenticated user', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('gpt-4');

    expect(mockOpenSignupModal).toHaveBeenCalledWith('GPT-4');
    expect(mockOpenPaymentModal).not.toHaveBeenCalled();
  });

  it('passes undefined name when model not found', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));

    result.current('unknown-model');

    expect(mockOpenPaymentModal).toHaveBeenCalledWith(undefined);
  });

  it('uses correct model name when clicking different models', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('llama-3');

    expect(mockOpenSignupModal).toHaveBeenCalledWith('Llama 3');
  });
});
