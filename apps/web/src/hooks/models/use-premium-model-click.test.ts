import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUIModalsStore } from '@/stores/ui/modals';
import { usePremiumModelClick } from '@/hooks/models/use-premium-model-click';
import type { Model } from '@hushbox/shared';

vi.mock('@/stores/ui/modals', () => ({
  useUIModalsStore: vi.fn(),
}));

const mockModels: Model[] = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    description: 'Premium model',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    supportedParameters: [],
    created: Date.now() / 1000,
    pricing: { inputPerToken: '30000', outputPerToken: '60000' },
  },
  {
    id: 'llama-3',
    name: 'Llama 3',
    description: 'Basic model',
    provider: 'Meta',
    modality: 'text' as const,
    contextLength: 8192,
    supportedParameters: [],
    created: Date.now() / 1000,
    pricing: { inputPerToken: '100', outputPerToken: '100' },
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

  it('opens payment modal for authenticated user', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));

    result.current('gpt-4', 'premium_requires_credit');

    expect(mockOpenPaymentModal).toHaveBeenCalledWith('GPT-4', 'premium_requires_credit', 'gpt-4');
    expect(mockOpenSignupModal).not.toHaveBeenCalled();
  });

  it('carries the refusal reason to the payment modal', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));

    result.current('gpt-4', 'model_output_cap_too_low');

    expect(mockOpenPaymentModal).toHaveBeenCalledWith('GPT-4', 'model_output_cap_too_low', 'gpt-4');
  });

  it('opens signup modal for unauthenticated user', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('gpt-4', 'premium_requires_account');

    expect(mockOpenSignupModal).toHaveBeenCalledWith('GPT-4', 'premium_requires_account', 'gpt-4');
    expect(mockOpenPaymentModal).not.toHaveBeenCalled();
  });

  it('carries a non-premium refusal reason to the signup modal', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('gpt-4', 'prompt_too_long');

    expect(mockOpenSignupModal).toHaveBeenCalledWith('GPT-4', 'prompt_too_long', 'gpt-4');
  });

  it('records the refused model id beside its name for the signup modal', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('llama-3', 'premium_requires_account');

    expect(mockOpenSignupModal.mock.calls[0]?.[2]).toBe('llama-3');
  });

  it('records the refused model id beside its name for the payment modal', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));

    result.current('gpt-4', 'insufficient_funds');

    expect(mockOpenPaymentModal.mock.calls[0]?.[2]).toBe('gpt-4');
  });

  it('records no model id when the model is not in the list, so the id never outlives the name', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('unknown-model', 'premium_requires_account');

    expect(mockOpenSignupModal.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('passes undefined name when model not found', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, true));

    result.current('unknown-model', 'premium_requires_credit');

    expect(mockOpenPaymentModal).toHaveBeenCalledWith(
      undefined,
      'premium_requires_credit',
      undefined
    );
  });

  it('uses correct model name when clicking different models', () => {
    const { result } = renderHook(() => usePremiumModelClick(mockModels, false));

    result.current('llama-3', 'premium_requires_account');

    expect(mockOpenSignupModal).toHaveBeenCalledWith(
      'Llama 3',
      'premium_requires_account',
      'llama-3'
    );
  });
});
