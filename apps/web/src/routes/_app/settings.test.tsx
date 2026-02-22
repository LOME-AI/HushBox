import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './settings';

// vi.hoisted values are available inside vi.mock factories (hoisted above imports)
const { mockChangePassword, mockUseAuthStore, useAuthStoreMock, mockAuthStoreState } = vi.hoisted(
  () => {
    const mockChangePasswordFunction = vi.fn();
    const mockUseAuthStoreFunction = vi.fn();

    // Default state returned by useAuthStore.getState() — RecoveryPhraseModal uses this
    const state = {
      user: null as {
        id: string;
        email: string;
        username: string;
        emailVerified: boolean;
        totpEnabled: boolean;
        hasAcknowledgedPhrase: boolean;
      } | null,
      privateKey: new Uint8Array(32),
      isLoading: false,
      isAuthenticated: true,
      setUser: vi.fn(),
      setPrivateKey: vi.fn(),
      setLoading: vi.fn(),
      clear: vi.fn(),
    };

    // useAuthStore must support both selector calls and .getState()
    const mock = Object.assign(
      (selector: (s: typeof state) => unknown) => mockUseAuthStoreFunction(selector),
      { getState: () => state }
    );

    return {
      mockChangePassword: mockChangePasswordFunction,
      mockUseAuthStore: mockUseAuthStoreFunction,
      mockAuthStoreState: state,
      useAuthStoreMock: mock,
    };
  }
);

const { mockDisable2FAInit, mockDisable2FAFinish } = vi.hoisted(() => ({
  mockDisable2FAInit: vi.fn(),
  mockDisable2FAFinish: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn().mockImplementation(() => Promise.resolve()),
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
  useAuthStore: useAuthStoreMock,
  disable2FAInit: (...args: unknown[]) => mockDisable2FAInit(...args),
  disable2FAFinish: (...args: unknown[]) => mockDisable2FAFinish(...args),
}));

// RecoveryPhraseModal imports getApiUrl from @/lib/api
vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock('@hushbox/crypto', () => ({
  regenerateRecoveryPhrase: vi.fn(() =>
    Promise.resolve({
      recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
      recoveryWrappedPrivateKey: new Uint8Array(64),
    })
  ),
  toBase64: vi.fn(() => 'base64-encoded-key'),
}));

document.elementFromPoint = vi.fn(() => null);

const mockClipboardWrite = vi.fn().mockImplementation(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockClipboardWrite },
  writable: true,
  configurable: true,
});

vi.mock('react-qrcode-logo', () => ({
  QRCode: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value}>
      QR Code Mock
    </div>
  ),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function setMockUser(
  overrides: {
    email?: string;
    emailVerified?: boolean;
    totpEnabled?: boolean;
    hasAcknowledgedPhrase?: boolean;
  } = {}
): void {
  const defaultUser = {
    id: 'user-1',
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
  };
  const user = { ...defaultUser, ...overrides };
  // Update both selector mock and getState().user for direct access
  mockAuthStoreState.user = user;
  mockUseAuthStore.mockImplementation((selector: (state: { user: typeof user }) => unknown) =>
    selector({ user })
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDisable2FAInit.mockResolvedValue({ success: true, ke3: [4, 5, 6] });
    mockDisable2FAFinish.mockResolvedValue({ success: true });
    setMockUser();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          secret: 'JBSWY3DPEHPK3PXP',
          totpUri: 'otpauth://totp/test',
        }),
    });
  });

  describe('rendering', () => {
    it('renders page with Settings title', () => {
      render(<SettingsPage />);

      expect(screen.getByTestId('page-header-title')).toHaveTextContent('Settings');
    });

    it('shows security section with manage authentication description', () => {
      render(<SettingsPage />);

      expect(screen.getByText('Security')).toBeInTheDocument();
      expect(screen.getByText('Manage authentication')).toBeInTheDocument();
    });

    it('shows change password option', () => {
      render(<SettingsPage />);

      expect(screen.getByText('Change Password')).toBeInTheDocument();
    });

    it('shows two-factor authentication option', () => {
      render(<SettingsPage />);

      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
    });

    it('shows recovery phrase option with description', () => {
      render(<SettingsPage />);

      expect(screen.getByText('Recovery Phrase')).toBeInTheDocument();
      expect(screen.getByText('Protect from forgetting your password')).toBeInTheDocument();
    });

    it('shows "Add an extra layer of security" when 2FA is disabled', () => {
      setMockUser({ totpEnabled: false });
      render(<SettingsPage />);

      expect(screen.getByText('Add an extra layer of security')).toBeInTheDocument();
    });

    it('shows "Manage your authentication security" when 2FA is enabled', () => {
      setMockUser({ totpEnabled: true });
      render(<SettingsPage />);

      expect(screen.getByText('Manage your authentication security')).toBeInTheDocument();
    });
  });

  describe('legal card', () => {
    it('renders legal card with title and description', () => {
      render(<SettingsPage />);

      expect(screen.getByText('Legal')).toBeInTheDocument();
      expect(screen.getByText('Terms and policies')).toBeInTheDocument();
    });

    it('renders Terms of Service link', () => {
      render(<SettingsPage />);

      const termsLink = screen.getByRole('link', { name: /terms of service/i });
      expect(termsLink).toHaveAttribute('href', '/terms');
    });

    it('renders Privacy Policy link', () => {
      render(<SettingsPage />);

      const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
      expect(privacyLink).toHaveAttribute('href', '/privacy');
    });

    it('renders effective date', () => {
      render(<SettingsPage />);

      expect(screen.getByText(/Effective:/)).toBeInTheDocument();
    });
  });

  describe('account card', () => {
    it('renders account card with brand-colored title', () => {
      render(<SettingsPage />);

      expect(screen.getByText('Account')).toBeInTheDocument();
      expect(screen.getByText('Your account information')).toBeInTheDocument();
    });

    it('displays user email', () => {
      setMockUser({ email: 'user@hushbox.ai' });
      render(<SettingsPage />);

      expect(screen.getByText('user@hushbox.ai')).toBeInTheDocument();
    });

    it('shows Verified badge when email is verified', () => {
      setMockUser({ emailVerified: true });
      render(<SettingsPage />);

      expect(screen.getByText('Verified')).toBeInTheDocument();
    });

    it('shows Not verified badge when email is not verified', () => {
      setMockUser({ emailVerified: false });
      render(<SettingsPage />);

      expect(screen.getByText('Not verified')).toBeInTheDocument();
    });
  });

  describe('status badges', () => {
    it('shows Enabled badge when 2FA is enabled', () => {
      setMockUser({ totpEnabled: true });
      render(<SettingsPage />);

      const badges = screen.getAllByText('Enabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Disabled badge when 2FA is disabled', () => {
      setMockUser({ totpEnabled: false });
      render(<SettingsPage />);

      const badges = screen.getAllByText('Disabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Enabled badge for recovery phrase when acknowledged', () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      render(<SettingsPage />);

      const badges = screen.getAllByText('Enabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Disabled badge for recovery phrase when not acknowledged', () => {
      setMockUser({ hasAcknowledgedPhrase: false });
      render(<SettingsPage />);

      const badges = screen.getAllByText('Disabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('change password modal', () => {
    it('opens change password modal when button is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /change password.*update/i }));

      await waitFor(() => {
        expect(screen.getAllByText('Change Password')[1]).toBeInTheDocument();
      });
    });
  });

  describe('two-factor authentication modal', () => {
    it('opens 2FA setup modal when button is clicked', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*extra/i }));

      await waitFor(() => {
        expect(screen.getByTestId('two-factor-setup-modal')).toBeInTheDocument();
      });
    });

    it('updates user state with totpEnabled after 2FA success', async () => {
      // Setup: first call returns TOTP data, second call is verify success
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              secret: 'JBSWY3DPEHPK3PXP',
              totpUri: 'otpauth://totp/test',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = userEvent.setup();
      render(<SettingsPage />);

      // Open 2FA modal
      await user.click(screen.getByRole('button', { name: /two-factor authentication.*extra/i }));

      // Click "Get Started" to trigger TOTP fetch and transition to scan step
      await user.click(await screen.findByRole('button', { name: /get started/i }));

      // Wait for scan step
      await waitFor(() => {
        expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
      });

      // Continue to verify
      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Enter code (auto-submits on complete)
      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Wait for success step
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      // Click Done
      await user.click(screen.getByRole('button', { name: /done/i }));

      // Verify user state was updated with totpEnabled: true
      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ totpEnabled: true })
        );
      });
    }, 15_000);

    it('opens 2FA disable modal when button is clicked and 2FA is enabled', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*manage/i }));

      await waitFor(() => {
        expect(screen.getByTestId('disable-two-factor-modal')).toBeInTheDocument();
      });
    });

    it('updates user state with totpEnabled false after 2FA disable success', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      render(<SettingsPage />);

      // Open 2FA disable modal
      await user.click(screen.getByRole('button', { name: /two-factor authentication.*manage/i }));

      await waitFor(() => {
        expect(screen.getByTestId('disable-two-factor-modal')).toBeInTheDocument();
      });

      // Enter password and submit
      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Wait for code step
      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      // Enter OTP (auto-submits on 6 digits)
      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      // Verify user state was updated with totpEnabled: false
      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ totpEnabled: false })
        );
      });
    }, 15_000);
  });

  describe('recovery phrase flow', () => {
    it('opens recovery phrase modal directly when user has no phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByTestId('recovery-phrase-modal')).toBeInTheDocument();
      });
    });

    it('shows confirmation modal when user already has a phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
        expect(
          screen.getByText(
            'You already have a recovery phrase. If you generate a new one, your previous phrase will no longer work.'
          )
        ).toBeInTheDocument();
      });
    });

    it('closes confirmation modal when Cancel is clicked', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Regenerate Recovery Phrase?')).not.toBeInTheDocument();
      });
    });

    it('opens recovery phrase modal when Generate New is clicked', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      render(<SettingsPage />);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /generate new/i }));

      await waitFor(() => {
        expect(screen.getByTestId('recovery-phrase-modal')).toBeInTheDocument();
      });
    });
  });
});
