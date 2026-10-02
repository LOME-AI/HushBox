// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import {
  installThemeTokens,
  installThemeTokensWithout,
  THEME_TOKEN_FIXTURE,
} from '@/test-utils/theme-tokens.js';
import { TwoFactorSetup } from './two-factor-setup';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Only the base URL is stubbed: `fetchJson` throws the module's own `ApiError`,
// and the component narrows on it, so the real class has to stay in place.
vi.mock('@/lib/api/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/api')>()),
  getApiUrl: () => 'http://localhost:8787',
}));

// Mock QRCode component (uses canvas which isn't available in jsdom)
vi.mock('react-qrcode-logo', () => ({
  QRCode: ({ value, eyeColor }: { value: string; eyeColor: string }) => (
    <div data-testid="qr-code" data-value={value} data-eye-color={eyeColor}>
      QR Code Mock
    </div>
  ),
}));

// Mock document.elementFromPoint (used by input-otp, not available in jsdom)
document.elementFromPoint = vi.fn(() => null);

/**
 * A viewport `width` CSS pixels wide whose primary pointer is `pointer`, as
 * `matchMedia` reports it: a max-width query matches at or below its bound,
 * and the coarse-pointer query matches only for a coarse pointer.
 */
function stubFormFactor(width: number, pointer: 'fine' | 'coarse'): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches =
      maxWidth === null
        ? query === '(pointer: coarse)' && pointer === 'coarse'
        : width <= Number(maxWidth[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

describe('TwoFactorSetup', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  const mockTotpResponse = {
    secret: 'JBSWY3DPEHPK3PXP',
    totpUri: 'otpauth://totp/HushBox:test@example.com?secret=JBSWY3DPEHPK3PXP&issuer=HushBox',
  };

  // The QR eyes are painted onto a canvas, which sits outside the cascade and
  // takes a resolved colour; the reader refuses an undefined token rather than
  // handing the canvas one it will silently ignore.
  let removeThemeTokens: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    removeThemeTokens = installThemeTokens();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockTotpResponse),
    });
  });

  afterEach(() => {
    removeThemeTokens();
  });

  async function goToScanStep(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    render(<TwoFactorSetup {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /get started/i }));

    await waitFor(() => {
      expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
    });

    return user;
  }

  async function goToVerifyStep(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = await goToScanStep();

    await user.click(screen.getByRole('button', { name: /continue/i }));

    return user;
  }

  // Radix moves focus to the first control on open. On a bottom sheet, and on a
  // dialog under a coarse pointer, the overlay's open-autofocus handler cancels
  // that and focuses the sheet or dialog element instead, so no field raises a
  // soft keyboard.
  describe('focus on open at each form factor', () => {
    it('holds focus on the dialog itself on a phone, so no keyboard rises over it', async () => {
      stubFormFactor(390, 'coarse');
      render(<TwoFactorSetup {...defaultProps} />);

      expect(await screen.findByRole('dialog')).toHaveFocus();
    });

    it('holds focus on the dialog itself at a phone width with a fine pointer', async () => {
      stubFormFactor(390, 'fine');
      render(<TwoFactorSetup {...defaultProps} />);

      expect(await screen.findByRole('dialog')).toHaveFocus();
    });

    it('holds focus on the dialog itself on a tablet, whose pointer is coarse', async () => {
      stubFormFactor(834, 'coarse');
      render(<TwoFactorSetup {...defaultProps} />);

      expect(await screen.findByRole('dialog')).toHaveFocus();
    });

    it('moves focus to a control inside the dialog on a desktop with a fine pointer', async () => {
      stubFormFactor(1440, 'fine');
      render(<TwoFactorSetup {...defaultProps} />);

      const dialog = await screen.findByRole('dialog');
      expect(dialog).not.toHaveFocus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  describe('Step 1: Intro', () => {
    it('shows intro with Get Started button on open', () => {
      render(<TwoFactorSetup {...defaultProps} />);

      expect(screen.getByText('Set Up Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByText(/add an extra layer of security/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument();
    });

    it('names the dialog with the visible step heading', () => {
      render(<TwoFactorSetup {...defaultProps} />);

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Set Up Two-Factor Authentication');
    });

    it('does not fetch TOTP secret until Get Started is clicked', () => {
      render(<TwoFactorSetup {...defaultProps} />);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches TOTP secret and transitions to scan when Get Started is clicked', async () => {
      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/auth/2fa/setup',
        expect.any(Object)
      );
    });

    it('does not show back button on intro step', () => {
      render(<TwoFactorSetup {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });
  });

  describe('Step 2: Scan QR Code', () => {
    it('shows QR code after Get Started', async () => {
      await goToScanStep();

      expect(screen.getByText(/open your authenticator app/i)).toBeInTheDocument();
    });

    it('paints the QR eyes with the brand colour the stylesheet defines', async () => {
      await goToScanStep();

      // The canvas takes a resolved colour, so the token is read off the
      // cascade rather than worn as a class. The fixture's value is nothing
      // like the real brand red, so matching it can only mean the cascade
      // was read.
      expect(screen.getByTestId('qr-code')).toHaveAttribute(
        'data-eye-color',
        THEME_TOKEN_FIXTURE['--brand-red']
      );
    });

    it('still reaches the scan step when the cascade omits a token the QR never asks for', async () => {
      removeThemeTokens();
      removeThemeTokens = installThemeTokensWithout(['--background']);

      await goToScanStep();

      expect(screen.getByTestId('qr-code')).toHaveAttribute(
        'data-eye-color',
        THEME_TOKEN_FIXTURE['--brand-red']
      );
    });

    it('shows the TOTP secret for manual entry', async () => {
      await goToScanStep();

      expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
      expect(screen.getByText(/can't scan/i)).toBeInTheDocument();
    });

    it('has a copy button for the secret', async () => {
      await goToScanStep();

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies secret to clipboard when copy button is clicked', async () => {
      const user = await goToScanStep();

      await user.click(screen.getByRole('button', { name: /copy/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('does not acknowledge the copy when the clipboard write fails', async () => {
      const user = await goToScanStep();
      // userEvent.setup() installs its own navigator.clipboard stub, so a failing
      // clipboard has to replace it after the session exists, not before.
      const writeText = vi.fn().mockRejectedValue(new Error('clipboard refused'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalled();
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    });

    it('clears the copy acknowledgement when the scan step is returned to', async () => {
      const user = await goToScanStep();

      await user.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    });

    it('has continue button to proceed to verification', async () => {
      await goToScanStep();

      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    });

    it('advances to verify step when continue is clicked', async () => {
      const user = await goToScanStep();

      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
    });

    it('shows back button on QR step', async () => {
      await goToScanStep();

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('goes back to intro when back button is clicked without re-fetching', async () => {
      const user = await goToScanStep();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByText('Set Up Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Step 3: Verify Code', () => {
    it('shows OTP input for 6-digit code', async () => {
      await goToVerifyStep();

      expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument();
    });

    it('has verify button that is disabled when code is incomplete', async () => {
      await goToVerifyStep();

      const verifyButton = screen.getByRole('button', { name: /verify/i });
      expect(verifyButton).toBeDisabled();
    });

    it('shows back button on verify step', async () => {
      await goToVerifyStep();

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('goes back to QR step when back button is clicked', async () => {
      const user = await goToVerifyStep();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
    });

    it('shows loading state when 6 digits are entered', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockImplementationOnce(() => new Promise(() => {}));

      const user = await goToVerifyStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/verifying/i)).toBeInTheDocument();
      });
    });

    it('shows error when verification fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: false,
          headers: new Headers(),
          json: () => Promise.resolve({ code: 'INVALID_TOTP_CODE' }),
        });

      const user = await goToVerifyStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/that code is incorrect or has expired/i)).toBeInTheDocument();
      });
    });

    it('advances to success step when verification succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = await goToVerifyStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText('Two-Factor Authentication Enabled')).toBeInTheDocument();
      });
    });

    it('auto-submits verification code when 6 digits are entered', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = await goToVerifyStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:8787/auth/2fa/verify',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ code: '123456' }),
          })
        );
      });
    });

    it('clears input on verification failure', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: false,
          headers: new Headers(),
          json: () => Promise.resolve({ code: 'INVALID_TOTP_CODE' }),
        });

      const user = await goToVerifyStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
      });
    });
  });

  describe('Step 4: Success', () => {
    async function goToSuccessStep(): Promise<ReturnType<typeof userEvent.setup>> {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText('Two-Factor Authentication Enabled')).toBeInTheDocument();
      });

      return user;
    }

    it('shows success message', async () => {
      await goToSuccessStep();

      expect(screen.getByText('Two-Factor Authentication Enabled')).toBeInTheDocument();
      expect(screen.getByText(/your account is now more secure/i)).toBeInTheDocument();
    });

    it('names the dialog with the success heading', async () => {
      await goToSuccessStep();

      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
      expect(screen.getByRole('dialog')).toHaveAccessibleName('Two-Factor Authentication Enabled');
    });

    it('shows Done button', async () => {
      await goToSuccessStep();

      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    });

    it('calls onSuccess when Done is clicked', async () => {
      const onSuccess = vi.fn();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} onSuccess={onSuccess} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /done/i }));

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('does not show back button on success step', async () => {
      await goToSuccessStep();

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });
  });

  describe('Modal behavior', () => {
    it('does not render when open is false', () => {
      render(<TwoFactorSetup {...defaultProps} open={false} />);

      expect(screen.queryByText('Set Up Two-Factor Authentication')).not.toBeInTheDocument();
    });

    it('widens past the overlay width only from the md breakpoint up', () => {
      render(<TwoFactorSetup {...defaultProps} />);

      const content = screen.getByTestId(TEST_IDS.twoFactorSetupModal);
      expect(content).toHaveClass('md:w-[75vw]');
      expect(content).not.toHaveClass('w-[75vw]');
    });

    it('sends verify request to full API URL', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:8787/auth/2fa/verify',
          expect.objectContaining({
            method: 'POST',
            credentials: 'include',
          })
        );
      });
    });
  });

  describe('Error handling', () => {
    it('shows error when setup fetch returns non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'NOT_AUTHENTICATED' }),
      });

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to initialize two-factor setup/i)).toBeInTheDocument();
      });
    });

    it('shows specific error when 2FA is already enabled', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        headers: new Headers(),
        json: () => Promise.resolve({ code: 'TOTP_ALREADY_ENABLED' }),
      });

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/two-factor authentication is already enabled/i)
        ).toBeInTheDocument();
      });
    });

    it('shows a generic setup error when the setup request throws', async () => {
      mockFetch.mockReset();
      mockFetch.mockRejectedValue(new Error('network down'));

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('TWO_FACTOR_SETUP_FAILED'))
        ).toBeInTheDocument();
      });
    });

    it('rejects a setup response whose body does not match the route contract', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ secret: 'JBSWY3DPEHPK3PXP' }),
      });

      const user = userEvent.setup();
      render(<TwoFactorSetup {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('TWO_FACTOR_SETUP_FAILED'))
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
    });

    it('shows a generic verification error when the failure body is unparseable', async () => {
      // Setup succeeds, then verify fails with a body that does not match the
      // `{ code }` error contract, so the generic verification copy is shown.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockTotpResponse),
        })
        .mockResolvedValueOnce({
          ok: false,
          headers: new Headers(),
          json: () => Promise.resolve({ message: 'not a code' }),
        });

      const user = await goToVerifyStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('TWO_FACTOR_VERIFICATION_FAILED'))
        ).toBeInTheDocument();
      });
    });
  });
});
