import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwoFactorInput } from './TwoFactorInput';

// Mock useIsMobile hook
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Mock document.elementFromPoint (used by input-otp, not available in jsdom)
document.elementFromPoint = vi.fn(() => null);

describe('TwoFactorInput', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
    onVerify: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    defaultProps.onVerify.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('renders modal with title when open', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument();
    });

    it('does not render when open is false', () => {
      render(<TwoFactorInput {...defaultProps} open={false} />);

      expect(screen.queryByText('Two-Factor Authentication')).not.toBeInTheDocument();
    });

    it('shows OTP input for 6 digits', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByTestId('otp-input')).toBeInTheDocument();
    });

    it('shows verify button', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
    });
  });

  describe('verification', () => {
    it('disables verify button when code is incomplete', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
    });

    it('enables verify button when 6 digits are entered', async () => {
      const user = userEvent.setup();
      render(<TwoFactorInput {...defaultProps} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      expect(screen.getByRole('button', { name: /verify/i })).not.toBeDisabled();
    });

    it('calls onVerify with the code when verify button is clicked', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Auto-submit triggers onVerify without needing a button click
      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledWith('123456');
      });
    });

    it('calls onSuccess when verification succeeds', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows error when verification fails', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'Invalid code' });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
      });
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
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Auto-submit triggers loading state
      await waitFor(() => {
        expect(screen.getByText(/verifying/i)).toBeInTheDocument();
      });

      // Resolve the verification
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveVerify) throw new Error('Expected resolveVerify');
      resolveVerify({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });
  });

  describe('auto-submit', () => {
    it('auto-submits when all 6 digits are entered', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      const onSuccess = vi.fn();
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledWith('123456');
      });
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('clears input on verification failure', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'INVALID_TOTP_CODE' });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Wait for verification to complete and input to clear
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
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Auto-submit fires, now try clicking the button while verifying
      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledTimes(1);
      });

      await user.click(screen.getByRole('button', { name: /verifying/i }));

      // Should still only have been called once
      expect(onVerify).toHaveBeenCalledTimes(1);

      // Clean up
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveVerify) throw new Error('Expected resolveVerify');
      resolveVerify({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });
  });

  describe('recovery code option', () => {
    it('shows link to use recovery code when showRecoveryOption is true', () => {
      render(<TwoFactorInput {...defaultProps} showRecoveryOption={true} />);

      expect(screen.getByRole('button', { name: /use recovery code/i })).toBeInTheDocument();
    });

    it('does not show recovery option by default', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /use recovery code/i })).not.toBeInTheDocument();
    });

    it('calls onRecoveryClick when recovery link is clicked', async () => {
      const user = userEvent.setup();
      const onRecoveryClick = vi.fn();
      render(
        <TwoFactorInput
          {...defaultProps}
          showRecoveryOption={true}
          onRecoveryClick={onRecoveryClick}
        />
      );

      await user.click(screen.getByRole('button', { name: /use recovery code/i }));

      expect(onRecoveryClick).toHaveBeenCalledTimes(1);
    });
  });
});
