import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisableTwoFactorModal } from './DisableTwoFactorModal';

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

const { mockDisable2FAInit, mockDisable2FAFinish } = vi.hoisted(() => ({
  mockDisable2FAInit: vi.fn(),
  mockDisable2FAFinish: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  disable2FAInit: (...args: unknown[]) => mockDisable2FAInit(...args),
  disable2FAFinish: (...args: unknown[]) => mockDisable2FAFinish(...args),
}));

document.elementFromPoint = vi.fn(() => null);

describe('DisableTwoFactorModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDisable2FAInit.mockResolvedValue({ success: true, ke3: [4, 5, 6] });
    mockDisable2FAFinish.mockResolvedValue({ success: true });
  });

  describe('rendering', () => {
    it('renders modal with title when open', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(
        screen.getByRole('heading', { name: 'Disable Two-Factor Authentication' })
      ).toBeInTheDocument();
    });

    it('does not render when open is false', () => {
      render(<DisableTwoFactorModal {...defaultProps} open={false} />);

      expect(screen.queryByText('Disable Two-Factor Authentication')).not.toBeInTheDocument();
    });

    it('shows password step initially', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    });

    it('shows Continue button disabled initially', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    });
  });

  describe('Step 1: Password', () => {
    it('enables Continue button when password is entered', async () => {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');

      expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
    });

    it('shows loading state during password verification', async () => {
      const user = userEvent.setup();
      mockDisable2FAInit.mockImplementation(() => new Promise(() => {}));
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getByText(/verifying/i)).toBeInTheDocument();
    });

    it('advances to code step on successful password verification', async () => {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });
    });

    it('shows error on failed password verification', async () => {
      const user = userEvent.setup();
      mockDisable2FAInit.mockResolvedValue({
        success: false,
        error: 'Incorrect password.',
      });
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'wrongpassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Incorrect password.')).toBeInTheDocument();
      });
    });

    it('shows error on network failure', async () => {
      const user = userEvent.setup();
      mockDisable2FAInit.mockRejectedValue(new Error('Network error'));
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Failed to verify password. Please try again.')
        ).toBeInTheDocument();
      });
    });

    it('does not show back button on step 1', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('Enter on password input triggers password submission', async () => {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });
    });
  });

  describe('Step 2: TOTP Code', () => {
    async function goToCodeStep(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      return user;
    }

    it('shows OTP input and Disable 2FA button', async () => {
      await goToCodeStep();

      expect(screen.getByTestId('otp-input')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /disable 2fa/i })).toBeInTheDocument();
    });

    it('disables Disable 2FA button until 6 digits entered', async () => {
      await goToCodeStep();

      expect(screen.getByRole('button', { name: /disable 2fa/i })).toBeDisabled();
    });

    it('shows back button on step 2', async () => {
      await goToCodeStep();

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('returns to password step when back is clicked', async () => {
      const user = await goToCodeStep();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Disable Two-Factor Authentication' })
      ).toBeInTheDocument();
    });

    it('shows loading state during disable', async () => {
      mockDisable2FAFinish.mockImplementation(() => new Promise(() => {}));
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/disabling/i)).toBeInTheDocument();
      });
    });

    it('calls onSuccess on successful disable', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} onSuccess={onSuccess} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows error on invalid TOTP code', async () => {
      mockDisable2FAFinish.mockResolvedValue({
        success: false,
        error: 'Invalid verification code. Please try again.',
      });
      const user = await goToCodeStep();

      // Enter OTP (auto-submits on 6 digits)
      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(
          screen.getByText('Invalid verification code. Please try again.')
        ).toBeInTheDocument();
      });
    });

    it('auto-submits when all 6 digits are entered', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} onSuccess={onSuccess} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Should auto-submit without clicking the button
      await waitFor(() => {
        expect(mockDisable2FAFinish).toHaveBeenCalledWith([4, 5, 6], '123456');
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows loading state on auto-submit', async () => {
      mockDisable2FAFinish.mockImplementation(() => new Promise(() => {}));
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Should show loading without clicking the button
      await waitFor(() => {
        expect(screen.getByText(/disabling/i)).toBeInTheDocument();
      });
    });

    it('shows error on auto-submit failure', async () => {
      mockDisable2FAFinish.mockResolvedValue({
        success: false,
        error: 'Invalid verification code. Please try again.',
      });
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Should show error without clicking the button
      await waitFor(() => {
        expect(
          screen.getByText('Invalid verification code. Please try again.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('state reset', () => {
    it('resets all state when modal reopens', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<DisableTwoFactorModal {...defaultProps} />);

      // Type a password
      await user.type(screen.getByLabelText(/current password/i), 'mypassword');

      // Close modal
      rerender(<DisableTwoFactorModal {...defaultProps} open={false} />);

      // Reopen modal
      rerender(<DisableTwoFactorModal {...defaultProps} open={true} />);

      // Password should be cleared and we should be back on step 1
      expect(screen.getByLabelText(/current password/i)).toHaveValue('');
      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    });
  });
});
