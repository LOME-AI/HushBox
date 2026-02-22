import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOtpVerification } from './use-otp-verification';

describe('useOtpVerification', () => {
  const mockOnVerify = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnVerify.mockResolvedValue({ success: true });
  });

  function renderOtp(): { result: { current: ReturnType<typeof useOtpVerification> } } {
    return renderHook(() =>
      useOtpVerification({ onVerify: mockOnVerify, onSuccess: mockOnSuccess })
    );
  }

  it('calls onVerify with the entered code', async () => {
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(mockOnVerify).toHaveBeenCalledWith('123456');
    });
  });

  it('does not call onVerify when code has fewer than 6 digits', () => {
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123');
    });
    act(() => {
      result.current.handleVerify();
    });

    expect(mockOnVerify).not.toHaveBeenCalled();
  });

  it('does not call onVerify when already verifying', async () => {
    mockOnVerify.mockImplementation(() => new Promise(() => {}));
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(result.current.isVerifying).toBe(true);
    });

    act(() => {
      result.current.handleVerify();
    });

    expect(mockOnVerify).toHaveBeenCalledTimes(1);
  });

  it('sets isVerifying to true during verification', async () => {
    mockOnVerify.mockImplementation(() => new Promise(() => {}));
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(result.current.isVerifying).toBe(true);
    });
  });

  it('calls onSuccess when verification succeeds', async () => {
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('sets error and clears input on verification failure', async () => {
    mockOnVerify.mockResolvedValue({ success: false, error: 'Invalid code' });
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Invalid code');
      expect(result.current.otpValue).toBe('');
    });
  });

  it('uses default error when verification fails without error message', async () => {
    mockOnVerify.mockResolvedValue({ success: false });
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Verification failed');
    });
  });

  it('sets fallback error and clears input on thrown exception', async () => {
    mockOnVerify.mockRejectedValue(new Error('Network error'));
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Verification failed. Please try again.');
      expect(result.current.otpValue).toBe('');
    });
  });

  it('calls onVerify with code override via handleComplete', async () => {
    const { result } = renderOtp();

    act(() => {
      result.current.handleComplete('654321');
    });

    await waitFor(() => {
      expect(mockOnVerify).toHaveBeenCalledWith('654321');
    });
  });

  it('resets all state when reset is called', async () => {
    mockOnVerify.mockResolvedValue({ success: false, error: 'Bad code' });
    const { result } = renderOtp();

    act(() => {
      result.current.setOtpValue('123456');
    });
    act(() => {
      result.current.handleVerify();
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Bad code');
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.otpValue).toBe('');
    expect(result.current.error).toBeNull();
    expect(result.current.isVerifying).toBe(false);
  });
});
