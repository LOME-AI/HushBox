import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { CheckYourEmail } from './check-your-email';

const mockResendVerification = vi.fn();

vi.mock('@/lib/auth', () => ({
  authClient: {
    resendVerification: (...args: unknown[]) => mockResendVerification(...args),
  },
}));

describe('CheckYourEmail', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResendVerification.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders heading and email address', () => {
    render(<CheckYourEmail email="alice@example.com" />);

    expect(screen.getByRole('heading', { name: /check your email/i })).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('renders the resend button enabled by default', () => {
    render(<CheckYourEmail email="alice@example.com" />);
    const button = screen.getByTestId(TEST_IDS.resendButton);
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent(/resend verification email/i);
  });

  it('renders spam-folder hint', () => {
    render(<CheckYourEmail email="alice@example.com" />);
    expect(screen.getByText(/check your spam folder/i)).toBeInTheDocument();
  });

  it('shows "Sending..." text while resend is in flight', async () => {
    let resolveFunction: (value: { error: null }) => void = () => {};
    mockResendVerification.mockReturnValue(
      new Promise<{ error: null }>((resolve) => {
        resolveFunction = resolve;
      })
    );

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    expect(screen.getByTestId(TEST_IDS.resendButton)).toHaveTextContent(/sending/i);
    expect(screen.getByTestId(TEST_IDS.resendButton)).toBeDisabled();

    await act(async () => {
      resolveFunction({ error: null });
      await Promise.resolve();
    });
  });

  it('shows success feedback when resend succeeds', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const feedback = await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(feedback).toHaveTextContent(/verification email sent/i);
    expect(feedback.className).toContain('text-success');
  });

  it('starts cooldown after a successful resend', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const button = await screen.findByTestId(TEST_IDS.resendButton);
    expect(button).toHaveTextContent(/\d+s/);
    expect(button).toBeDisabled();
  });

  it('counts down each second after resend', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const button = await screen.findByTestId(TEST_IDS.resendButton);
    expect(button).toHaveTextContent('(60s)');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(button).toHaveTextContent('(59s)');
  });

  it('re-enables the button after cooldown elapses', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    await screen.findByText(/verification email sent/i);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByTestId(TEST_IDS.resendButton)).toBeEnabled();
    expect(screen.getByTestId(TEST_IDS.resendButton)).toHaveTextContent(
      /resend verification email/i
    );
  });

  it('renders error feedback when result.error is set', async () => {
    mockResendVerification.mockResolvedValue({
      error: { message: 'Rate limited' },
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const feedback = await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(feedback).toHaveTextContent(/rate limited/i);
    expect(feedback.className).toContain('text-destructive');
  });

  it('starts cooldown after a server error response', async () => {
    mockResendVerification.mockResolvedValue({
      error: { message: 'Rate limited' },
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const button = await screen.findByTestId(TEST_IDS.resendButton);
    expect(button).toHaveTextContent('(60s)');
    expect(button).toBeDisabled();
  });

  it('shows generic error message when resend throws', async () => {
    mockResendVerification.mockRejectedValue(new Error('boom'));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    const feedback = await screen.findByTestId(TEST_IDS.resendFeedback);
    expect(feedback).toHaveTextContent(/something went wrong/i);
    expect(feedback.className).toContain('text-destructive');
    // Throw path does NOT start cooldown
    expect(screen.getByTestId(TEST_IDS.resendButton)).toBeEnabled();
  });

  it('automatically resends once when autoResend is true', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    render(<CheckYourEmail email="alice@example.com" autoResend />);

    await screen.findByText(/verification email sent/i);
    expect(mockResendVerification).toHaveBeenCalledWith({ email: 'alice@example.com' });
    expect(mockResendVerification).toHaveBeenCalledTimes(1);
  });

  it('does not auto-resend when autoResend is false', () => {
    render(<CheckYourEmail email="alice@example.com" autoResend={false} />);
    expect(mockResendVerification).not.toHaveBeenCalled();
  });

  it('does not duplicate auto-resend on subsequent renders', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    const { rerender } = render(<CheckYourEmail email="alice@example.com" autoResend />);

    await screen.findByText(/verification email sent/i);

    rerender(<CheckYourEmail email="alice@example.com" autoResend />);
    rerender(<CheckYourEmail email="alice@example.com" autoResend />);

    expect(mockResendVerification).toHaveBeenCalledTimes(1);
  });

  it('clears prior feedback when a new resend starts', async () => {
    mockResendVerification.mockResolvedValueOnce({ error: { message: 'Rate limited' } });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="alice@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));
    await screen.findByText(/rate limited/i);

    // Wait out the cooldown so the button becomes clickable again.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    let resolveFunction: (v: { error: null }) => void = () => {};
    mockResendVerification.mockReturnValue(
      new Promise<{ error: null }>((resolve) => {
        resolveFunction = resolve;
      })
    );

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    expect(screen.queryByText(/rate limited/i)).not.toBeInTheDocument();

    await act(async () => {
      resolveFunction({ error: null });
      await Promise.resolve();
    });
  });

  it('passes the email to authClient.resendVerification', async () => {
    mockResendVerification.mockResolvedValue({ error: null });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckYourEmail email="bob@example.com" />);

    await user.click(screen.getByTestId(TEST_IDS.resendButton));

    await screen.findByText(/verification email sent/i);
    expect(mockResendVerification).toHaveBeenCalledWith({ email: 'bob@example.com' });
  });
});
