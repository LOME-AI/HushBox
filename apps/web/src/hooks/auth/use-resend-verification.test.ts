import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { resendButtonLabel, useResendVerification } from './use-resend-verification';
import type { authClient } from '@/lib/auth/auth';

type ResendVerification = typeof authClient.resendVerification;
type ResendAnswer = Awaited<ReturnType<ResendVerification>>;

const mockResendVerification = vi.fn<ResendVerification>();

vi.mock('@/lib/auth/auth', () => ({
  authClient: {
    resendVerification: (...args: Parameters<ResendVerification>) =>
      mockResendVerification(...args),
  },
}));

function holdAnswer(): (answer: ResendAnswer) => void {
  let settle: (answer: ResendAnswer) => void = () => {};
  mockResendVerification.mockReturnValue(
    new Promise<ResendAnswer>((resolve) => {
      settle = resolve;
    })
  );
  return (answer) => {
    settle(answer);
  };
}

describe('useResendVerification', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResendVerification.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle, with no cooldown and no feedback', () => {
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    expect(result.current.isSending).toBe(false);
    expect(result.current.cooldown).toBe(0);
    expect(result.current.feedback).toBeNull();
  });

  it('sends the address it was given to the resend endpoint', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result } = renderHook(() => useResendVerification('bob@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(mockResendVerification).toHaveBeenCalledWith({ email: 'bob@example.com' });
  });

  it('sends the address as it reads at the moment of sending', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result, rerender } = renderHook(
      ({ email }: { email: string }) => useResendVerification(email),
      { initialProps: { email: 'first@example.com' } }
    );

    rerender({ email: 'second@example.com' });
    await act(async () => {
      await result.current.send();
    });

    expect(mockResendVerification).toHaveBeenCalledWith({ email: 'second@example.com' });
  });

  it('reports sending while the request is in flight', async () => {
    const answer = holdAnswer();
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    act(() => {
      void result.current.send();
    });

    expect(result.current.isSending).toBe(true);
    await act(async () => {
      answer({});
      await Promise.resolve();
    });
    expect(result.current.isSending).toBe(false);
  });

  it('confirms a sent email', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.feedback).toEqual({
      message: 'Verification email sent.',
      isError: false,
    });
  });

  it('starts a sixty-second cooldown after a sent email', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.cooldown).toBe(60);
  });

  it("shows the server's refusal as an error", async () => {
    mockResendVerification.mockResolvedValue({ error: { message: 'Rate limited' } });
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.feedback).toEqual({ message: 'Rate limited', isError: true });
  });

  it('starts a sixty-second cooldown after a refusal', async () => {
    mockResendVerification.mockResolvedValue({ error: { message: 'Rate limited' } });
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.cooldown).toBe(60);
  });

  it('shows a generic error when the request throws', async () => {
    mockResendVerification.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.feedback).toEqual({
      message: 'Something went wrong. Please try again.',
      isError: true,
    });
  });

  it('starts no cooldown when the request throws', async () => {
    mockResendVerification.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useResendVerification('alice@example.com'));

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.cooldown).toBe(0);
    expect(result.current.isSending).toBe(false);
  });

  it('counts the cooldown down by one each second', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result } = renderHook(() => useResendVerification('alice@example.com'));
    await act(async () => {
      await result.current.send();
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.cooldown).toBe(59);
  });

  it('stops the cooldown at zero', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result } = renderHook(() => useResendVerification('alice@example.com'));
    await act(async () => {
      await result.current.send();
    });

    // One tick per act, as a browser renders between interval callbacks.
    for (let second = 0; second < 65; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }

    expect(result.current.cooldown).toBe(0);
  });

  it('clears the previous feedback when a new send starts', async () => {
    mockResendVerification.mockResolvedValueOnce({ error: { message: 'Rate limited' } });
    const { result } = renderHook(() => useResendVerification('alice@example.com'));
    await act(async () => {
      await result.current.send();
    });

    const answer = holdAnswer();
    act(() => {
      void result.current.send();
    });

    expect(result.current.feedback).toBeNull();
    await act(async () => {
      answer({});
      await Promise.resolve();
    });
  });

  it('sends nothing on its own by default', () => {
    renderHook(() => useResendVerification('alice@example.com'));

    expect(mockResendVerification).not.toHaveBeenCalled();
  });

  it('sends once on mount when asked to resend automatically', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result } = renderHook(() =>
      useResendVerification('alice@example.com', { autoResend: true })
    );

    await waitFor(() => {
      expect(result.current.feedback?.message).toBe('Verification email sent.');
    });
    expect(mockResendVerification).toHaveBeenCalledTimes(1);
    expect(mockResendVerification).toHaveBeenCalledWith({ email: 'alice@example.com' });
  });

  it('sends automatically only once across renders', async () => {
    mockResendVerification.mockResolvedValue({});
    const { result, rerender } = renderHook(() =>
      useResendVerification('alice@example.com', { autoResend: true })
    );
    await waitFor(() => {
      expect(result.current.feedback).not.toBeNull();
    });

    rerender();
    rerender();

    expect(mockResendVerification).toHaveBeenCalledTimes(1);
  });
});

describe('resendButtonLabel', () => {
  it('names the action when idle', () => {
    expect(resendButtonLabel(false, 0)).toBe('Resend verification email');
  });

  it('says it is sending while a send is in flight', () => {
    expect(resendButtonLabel(true, 0)).toBe('Sending...');
  });

  it('counts the seconds left in the cooldown', () => {
    expect(resendButtonLabel(false, 42)).toBe('Resend verification email (42s)');
  });

  it('says it is sending even while a cooldown is running', () => {
    expect(resendButtonLabel(true, 42)).toBe('Sending...');
  });
});
