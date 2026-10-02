import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { TwoFactorLoginStep } from './two-factor-login-step';
import type { FormFactor } from '@hushbox/ui/platform';

const formFactor = vi.hoisted((): { band: FormFactor['band'] } => ({ band: 'desktop' }));

vi.mock('@hushbox/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui/platform')>()),
  useFormFactor: (): FormFactor => ({ band: formFactor.band, pointer: 'fine' }),
}));

// Mock document.elementFromPoint (used by input-otp, not available in jsdom)
document.elementFromPoint = vi.fn(() => null);

const originalLocation = globalThis.location;
const signInCompletionMessage = friendlyErrorMessage('SIGN_IN_COMPLETION_FAILED');

describe('TwoFactorLoginStep', () => {
  const defaultProps = {
    onSuccess: vi.fn(),
    onVerify: vi.fn(),
    onBack: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    formFactor.band = 'desktop';
    defaultProps.onVerify.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    // The code field's own focus bookkeeping runs on timers, and it updates state.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  describe('rendering', () => {
    it('renders the step with its title and instruction', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(
        screen.getByRole('heading', { level: 1, name: 'Two-Factor Authentication' })
      ).toBeInTheDocument();
      expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument();
    });

    it('draws the title in the auth title role in Signal Red', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      const title = screen.getByRole('heading', { level: 1, name: 'Two-Factor Authentication' });
      expect(title).toHaveClass('text-auth-title');
      expect(title).not.toHaveClass('text-foreground');
    });

    it('draws the instruction as the muted line', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByText(/enter the 6-digit code/i).closest('p')).toHaveClass(
        'text-muted-foreground',
        'text-sm'
      );
    });

    it('balances the instruction so a narrow screen strands no word', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByText(/enter the 6-digit code/i)).toHaveClass('text-balance');
    });

    it('stacks the controls in a flex column so the link margin adds to the gap', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      const stack = screen.getByRole('button', { name: 'Verify' }).parentElement;
      expect(stack).toHaveClass('flex', 'flex-col', 'gap-2');
    });

    it('carries the step test id', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.twoFactorLoginStep)).toBeInTheDocument();
    });

    it('sits in the page rather than in a dialog', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows OTP input for 6 digits', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
    });

    it('draws the code cells in the field look', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      // The last cell, since the first is the active one while the field holds focus.
      expect(screen.getAllByText('○').at(-1)!.parentElement).toHaveClass(
        'border-2',
        'border-border-control'
      );
    });

    it('names the code field', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByRole('textbox', { name: '6-digit code' })).toBe(
        screen.getByTestId(TEST_IDS.otpInput)
      );
    });

    it('shows verify button', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
    });

    it('draws Verify as the extra-large full-width button', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      const verify = screen.getByRole('button', { name: 'Verify' });
      expect(verify).toHaveAttribute('data-size', 'xl');
      expect(verify).toHaveAttribute('data-block');
    });

    it('focuses the code field on arrival at desktop width', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.otpInput)).toHaveFocus();
    });

    it('leaves the code field unfocused on arrival on a phone', () => {
      formFactor.band = 'phone';
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.otpInput)).not.toHaveFocus();
    });
  });

  describe('back to login', () => {
    it('offers a way back to the login form', async () => {
      const user = userEvent.setup();
      const onBack = vi.fn();
      render(<TwoFactorLoginStep {...defaultProps} onBack={onBack} />);

      await user.click(screen.getByRole('button', { name: 'Back to login' }));

      expect(onBack).toHaveBeenCalledOnce();
    });

    it('draws Back to login as a link', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByRole('button', { name: 'Back to login' })).toHaveAttribute(
        'data-variant',
        'link'
      );
    });

    it('keeps Back to login out of the submit path', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByRole('button', { name: 'Back to login' })).toHaveAttribute(
        'type',
        'button'
      );
    });
  });

  describe('verification', () => {
    it('disables verify button when code is incomplete', () => {
      render(<TwoFactorLoginStep {...defaultProps} />);

      expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
    });

    it('enables verify button when 6 digits are entered', async () => {
      const user = userEvent.setup();
      // Held pending, so the code is neither accepted nor cleared while the button is read.
      const onVerify = vi.fn(() => new Promise<never>(() => {}));
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      expect(screen.getByRole('button', { name: /verify/i })).not.toBeDisabled();
    });

    it('calls onVerify with the code when verify button is clicked', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledWith('123456');
      });
    });

    it('calls onSuccess when verification succeeds', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows error when verification fails', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'Invalid code' });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
      });
    });

    it('announces a rejected code as an alert', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'Invalid code' });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      await user.click(screen.getByTestId(TEST_IDS.otpInput));
      await user.keyboard('123456');

      expect(await screen.findByRole('alert')).toHaveTextContent('Invalid code');
    });

    it('shows loading state during verification', async () => {
      const user = userEvent.setup();
      let resolveVerify: (value: { success: boolean }) => void = () => {};
      const onVerify = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          })
      );
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/verifying/i)).toBeInTheDocument();
      });

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveVerify) throw new Error('Expected resolveVerify');
      resolveVerify({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });

    it('re-runs verification for a new code after a failed verify', async () => {
      const user = userEvent.setup();
      const onVerify = vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: 'Invalid code' })
        .mockResolvedValueOnce({ success: true });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      await user.click(screen.getByTestId(TEST_IDS.otpInput));
      await user.keyboard('123456');
      await screen.findByRole('alert');
      await user.keyboard('654321');

      await waitFor(() => {
        expect(onVerify).toHaveBeenLastCalledWith('654321');
      });
      expect(onVerify).toHaveBeenCalledTimes(2);
    });
  });

  describe('an accepted code', () => {
    async function submitAcceptedCode(): Promise<{
      user: ReturnType<typeof userEvent.setup>;
      onVerify: ReturnType<typeof vi.fn>;
    }> {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      const onSuccess = vi.fn();
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);
      await user.click(screen.getByTestId(TEST_IDS.otpInput));
      await user.keyboard('123456');
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledOnce();
      });
      return { user, onVerify };
    }

    it('retires Verify once the code is accepted', async () => {
      await submitAcceptedCode();

      expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    });

    it('retires the code field once the code is accepted', async () => {
      await submitAcceptedCode();

      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeDisabled();
    });

    it('sends an accepted code only once', async () => {
      const { user, onVerify } = await submitAcceptedCode();

      await user.click(screen.getByRole('button', { name: 'Verify' }));

      expect(onVerify).toHaveBeenCalledOnce();
    });
  });

  describe('auto-submit', () => {
    it('auto-submits when all 6 digits are entered', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      const onSuccess = vi.fn();
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledWith('123456');
      });
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('does not submit before the sixth digit', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      await user.click(screen.getByTestId(TEST_IDS.otpInput));
      await user.keyboard('12345');

      expect(onVerify).not.toHaveBeenCalled();
    });

    it('clears input on verification failure', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'INVALID_TOTP_CODE' });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
      });
    });

    it('prevents double submission while verifying', async () => {
      const user = userEvent.setup();
      let resolveVerify: (value: { success: boolean }) => void = () => {};
      const onVerify = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          })
      );
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledTimes(1);
      });

      await user.click(screen.getByRole('button', { name: /verifying/i }));

      expect(onVerify).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveVerify) throw new Error('Expected resolveVerify');
      resolveVerify({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });
  });

  describe('finishing sign-in', () => {
    async function submitCodeThatCannotFinish(): Promise<void> {
      const user = userEvent.setup();
      const onVerify = vi
        .fn()
        .mockResolvedValue({ success: false, error: signInCompletionMessage });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledTimes(1);
      });
    }

    it('hides the code prompt when a verified code could not finish signing in', async () => {
      await submitCodeThatCannotFinish();

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.otpInput)).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /^verify$/i })).not.toBeInTheDocument();
    });

    it('tells the user the code was accepted', async () => {
      await submitCodeThatCannotFinish();

      await waitFor(() => {
        expect(screen.getByText(signInCompletionMessage)).toBeInTheDocument();
      });
      expect(
        screen.getByRole('heading', { level: 1, name: 'Finishing sign-in' })
      ).toBeInTheDocument();
    });

    it('moves focus to the finishing heading', async () => {
      await submitCodeThatCannotFinish();

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Finishing sign-in' })).toHaveFocus();
      });
    });

    it('moves focus to the finishing heading on a phone', async () => {
      formFactor.band = 'phone';
      await submitCodeThatCannotFinish();

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: 'Finishing sign-in' })).toHaveFocus();
      });
    });

    it('keeps the finishing state in the step', async () => {
      await submitCodeThatCannotFinish();

      const step = screen.getByTestId(TEST_IDS.twoFactorLoginStep);
      await waitFor(() => {
        expect(step).toHaveTextContent('Finishing sign-in');
      });
    });

    it('keeps Back to login out of the finishing state', async () => {
      await submitCodeThatCannotFinish();

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.otpInput)).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: 'Back to login' })).not.toBeInTheDocument();
    });

    it('reloads the page when the finishing action is used', async () => {
      const reloadMock = vi.fn();
      Object.defineProperty(globalThis, 'location', {
        value: { reload: reloadMock },
        writable: true,
        configurable: true,
      });
      await submitCodeThatCannotFinish();

      const reloadButton = await screen.findByRole('button', { name: /^reload$/i });
      await userEvent.setup().click(reloadButton);

      expect(reloadMock).toHaveBeenCalledOnce();
    });

    it('enters the finishing state from a supplied code the sentence does not name', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({
        success: false,
        error: 'A sentence the step has never seen.',
        errorCode: 'SIGN_IN_COMPLETION_FAILED',
      });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText('Finishing sign-in')).toBeInTheDocument();
      });
      expect(screen.queryByTestId(TEST_IDS.otpInput)).not.toBeInTheDocument();
    });

    it('keeps the code prompt when a supplied code is not the completion failure', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({
        success: false,
        error: signInCompletionMessage,
        errorCode: 'INVALID_TOTP_CODE',
      });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(signInCompletionMessage)).toBeInTheDocument();
      });
      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
    });

    it('still prompts for a code when the code itself was rejected', async () => {
      const user = userEvent.setup();
      const onVerify = vi
        .fn()
        .mockResolvedValue({ success: false, error: 'That code is incorrect or has expired.' });
      render(<TwoFactorLoginStep {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/incorrect or has expired/i)).toBeInTheDocument();
      });
      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
    });
  });
});
