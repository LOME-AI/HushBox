import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { DeleteAccountModal } from './DeleteAccountModal';

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

const { mockInitMutateAsync, mockFinishMutateAsync } = vi.hoisted(() => ({
  mockInitMutateAsync: vi.fn((_args: unknown) => Promise.resolve({ ke2: [] as number[] })),
  mockFinishMutateAsync: vi.fn((_args: unknown) => Promise.resolve()),
}));

vi.mock('@/hooks/useDeleteAccount', () => ({
  useDeleteAccountInit: () => ({
    mutateAsync: mockInitMutateAsync,
    isPending: false,
  }),
  useDeleteAccountFinish: () => ({
    mutateAsync: mockFinishMutateAsync,
    isPending: false,
  }),
}));

const { mockStartLogin, mockFinishLogin, mockCreateOpaqueClient } = vi.hoisted(() => ({
  mockStartLogin: vi.fn(),
  mockFinishLogin: vi.fn(),
  mockCreateOpaqueClient: vi.fn(() => ({})),
}));

vi.mock('@hushbox/crypto', () => ({
  createOpaqueClient: () => mockCreateOpaqueClient(),
  startLogin: (...args: unknown[]) => mockStartLogin(...args),
  finishLogin: (...args: unknown[]) => mockFinishLogin(...args),
  OPAQUE_SERVER_IDENTIFIER: 'test-identifier',
}));

const { mockUseBalance } = vi.hoisted(() => ({
  mockUseBalance: vi.fn(),
}));

vi.mock('@/hooks/billing', () => ({
  useBalance: () => mockUseBalance(),
}));

const { mockUseAuthUser } = vi.hoisted(() => ({
  mockUseAuthUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (state: { user: { totpEnabled: boolean } | null }) => unknown) =>
      selector({ user: mockUseAuthUser() }),
    {
      getState: () => ({
        user: mockUseAuthUser(),
        clear: vi.fn(),
      }),
    }
  ),
}));

const { mockQueryClientClear } = vi.hoisted(() => ({
  mockQueryClientClear: vi.fn(),
}));

vi.mock('@/providers/query-provider', () => ({
  queryClient: { clear: mockQueryClientClear },
}));

document.elementFromPoint = vi.fn(() => null);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

interface ModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function renderModal(props: ModalProps = {}): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(<DeleteAccountModal open={true} onOpenChange={vi.fn()} {...props} />, {
    wrapper: createWrapper(),
  });
  return user;
}

describe('DeleteAccountModal', () => {
  const originalLocation = globalThis.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBalance.mockReturnValue({ data: { balance: '0.00000000', freeAllowanceCents: 0 } });
    mockUseAuthUser.mockReturnValue({ totpEnabled: false });
    mockStartLogin.mockResolvedValue({ ke1: [1, 2, 3] });
    mockFinishLogin.mockResolvedValue({ ke3: [4, 5, 6], exportKey: new Uint8Array() });
    mockInitMutateAsync.mockResolvedValue({ ke2: [7, 8, 9] });
    mockFinishMutateAsync.mockResolvedValue();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  describe('Step 1: What happens', () => {
    it('renders the heading', () => {
      renderModal();
      expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      renderModal({ open: false });
      expect(
        screen.queryByRole('heading', { name: /delete your account/i })
      ).not.toBeInTheDocument();
    });

    it('explains what gets deleted and what is retained', () => {
      renderModal();
      expect(screen.getByText(/conversations/i)).toBeInTheDocument();
      expect(screen.getByText(/billing/i)).toBeInTheDocument();
    });

    it('emphasises irreversibility', () => {
      renderModal();
      expect(screen.getByText(/cannot be undone|irreversible|permanently/i)).toBeInTheDocument();
    });

    it('has a cancel button and a Continue button', () => {
      renderModal();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    });

    it('calls onOpenChange(false) when Cancel is clicked', async () => {
      const onOpenChange = vi.fn();
      const user = renderModal({ onOpenChange });
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('treats a null user as 2FA-disabled', async () => {
      mockUseAuthUser.mockReturnValue(null);
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'pw');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
    });

    it('treats a non-numeric balance as zero and skips the wallet step', async () => {
      mockUseBalance.mockReturnValue({ data: { balance: 'not-a-number', freeAllowanceCents: 0 } });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  describe('Step 2: Wallet balance (conditional)', () => {
    it('skips wallet step when balance is zero', async () => {
      mockUseBalance.mockReturnValue({ data: { balance: '0.00000000', freeAllowanceCents: 0 } });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByText(/forfeit/i)).not.toBeInTheDocument();
    });

    it('skips wallet step when balance data is undefined', async () => {
      mockUseBalance.mockReturnValue({ data: undefined });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });

    it('shows wallet step when balance is greater than zero', async () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '12.34000000', freeAllowanceCents: 0 },
      });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getAllByText(/\$12\.34/).length).toBeGreaterThan(0);
      expect(screen.getByRole('checkbox', { name: /forfeit/i })).toBeInTheDocument();
    });

    it('disables Continue until forfeit checkbox is checked', async () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '12.34000000', freeAllowanceCents: 0 },
      });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));

      const continueButton = screen.getByRole('button', { name: /continue/i });
      expect(continueButton).toBeDisabled();

      const checkbox = screen.getByRole('checkbox', { name: /forfeit/i });
      await user.click(checkbox);

      expect(continueButton).not.toBeDisabled();
    });

    it('Back from wallet step returns to step 1', async () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '12.34000000', freeAllowanceCents: 0 },
      });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
    });

    it('Continue from wallet step advances to password step', async () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '12.34000000', freeAllowanceCents: 0 },
      });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('checkbox', { name: /forfeit/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  describe('Step 3: Password', () => {
    async function advanceToPasswordStep(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      return user;
    }

    it('renders a password input', async () => {
      await advanceToPasswordStep();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });

    it('disables Continue until password is entered', async () => {
      const user = await advanceToPasswordStep();
      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

      await user.type(screen.getByLabelText('Password'), 'p');
      expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
    });

    it('runs OPAQUE start/finish and stores ke3 then advances', async () => {
      mockUseAuthUser.mockReturnValue({ totpEnabled: false });
      const user = await advanceToPasswordStep();

      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(mockStartLogin).toHaveBeenCalled();
        expect(mockInitMutateAsync).toHaveBeenCalledWith({ ke1: [1, 2, 3] });
        expect(mockFinishLogin).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
    });

    it('shows friendly error on init failure', async () => {
      mockInitMutateAsync.mockRejectedValueOnce(
        Object.assign(new Error('init failed'), { code: 'INCORRECT_PASSWORD' })
      );
      const user = await advanceToPasswordStep();

      await user.type(screen.getByLabelText('Password'), 'wrongpw');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/incorrect password/i)).toBeInTheDocument();
      });
    });

    it('maps client-side finishLogin failure to INCORRECT_PASSWORD message', async () => {
      // OPAQUE init returns ke2 unconditionally; the wrong-password failure surfaces
      // when finishLogin throws on the client. The modal must surface this as
      // INCORRECT_PASSWORD, not the generic INTERNAL fallback.
      mockFinishLogin.mockRejectedValueOnce(new Error('EnvelopeRecoveryError'));
      const user = await advanceToPasswordStep();

      await user.type(screen.getByLabelText('Password'), 'wrongpw');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/incorrect password/i)).toBeInTheDocument();
      });
    });

    it('Back returns to step 1 when balance is zero', async () => {
      const user = await advanceToPasswordStep();
      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
    });

    it('Back returns to wallet step when balance is greater than zero', async () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '5.00000000', freeAllowanceCents: 0 },
      });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('checkbox', { name: /forfeit/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('checkbox', { name: /forfeit/i })).toBeInTheDocument();
    });
  });

  describe('Step 4: TOTP code (conditional)', () => {
    async function advanceToTotpStep(): Promise<ReturnType<typeof userEvent.setup>> {
      mockUseAuthUser.mockReturnValue({ totpEnabled: true });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => {
        expect(screen.getByTestId('otp-input')).toBeInTheDocument();
      });
      return user;
    }

    it('shows the OTP input when user has 2FA', async () => {
      await advanceToTotpStep();
      expect(screen.getByTestId('otp-input')).toBeInTheDocument();
    });

    it('skips TOTP step when user has no 2FA', async () => {
      mockUseAuthUser.mockReturnValue({ totpEnabled: false });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('otp-input')).not.toBeInTheDocument();
    });

    it('advances to final step after entering 6 digits', async () => {
      const user = await advanceToTotpStep();
      const otpInput = screen.getByTestId('otp-input');
      await user.click(otpInput);
      await user.keyboard('123456');

      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
    });

    it('Back returns to password step', async () => {
      const user = await advanceToTotpStep();
      await user.click(screen.getByRole('button', { name: /back/i }));
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  describe('Step 5: Final confirmation', () => {
    async function advanceToFinalStep(options?: {
      withTotp?: boolean;
    }): Promise<ReturnType<typeof userEvent.setup>> {
      mockUseAuthUser.mockReturnValue({ totpEnabled: options?.withTotp === true });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      if (options?.withTotp === true) {
        await waitFor(() => {
          expect(screen.getByTestId('otp-input')).toBeInTheDocument();
        });
        const otpInput = screen.getByTestId('otp-input');
        await user.click(otpInput);
        await user.keyboard('123456');
        await user.click(screen.getByRole('button', { name: /continue/i }));
      }

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });

      return user;
    }

    it('shows the confirmation phrase prompt', async () => {
      await advanceToFinalStep();
      expect(screen.getByRole('heading', { name: /type delete my account/i })).toBeInTheDocument();
    });

    it('disables the delete button until the phrase matches', async () => {
      const user = await advanceToFinalStep();
      const deleteButton = screen.getByRole('button', { name: /delete account permanently/i });
      expect(deleteButton).toBeDisabled();

      const input = screen.getByLabelText(/confirmation/i);
      await user.type(input, 'wrong');
      expect(deleteButton).toBeDisabled();
    });

    it('enables the delete button on exact match', async () => {
      const user = await advanceToFinalStep();
      const input = screen.getByLabelText(/confirmation/i);
      await user.type(input, 'delete my account');

      expect(
        screen.getByRole('button', { name: /delete account permanently/i })
      ).not.toBeDisabled();
    });

    it('enables the delete button when the phrase is trimmed and lowercased', async () => {
      const user = await advanceToFinalStep();
      const input = screen.getByLabelText(/confirmation/i);
      await user.type(input, '  DELETE My Account  ');

      expect(
        screen.getByRole('button', { name: /delete account permanently/i })
      ).not.toBeDisabled();
    });

    it('submits, redirects, and clears state on 204', async () => {
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(mockFinishMutateAsync).toHaveBeenCalledWith({
          ke3: [4, 5, 6],
          confirmationPhrase: 'delete my account',
        });
      });

      await waitFor(() => {
        expect(globalThis.location.href).toContain('hushbox.ai');
      });
    });

    it('includes totpCode when user has 2FA', async () => {
      const user = await advanceToFinalStep({ withTotp: true });
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(mockFinishMutateAsync).toHaveBeenCalledWith({
          ke3: [4, 5, 6],
          totpCode: '123456',
          confirmationPhrase: 'delete my account',
        });
      });
    });

    it('shows friendly error on finish failure', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        Object.assign(new Error('finish failed'), { code: 'INVALID_TOTP_CODE' })
      );
      const user = await advanceToFinalStep({ withTotp: true });
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByText(/verification code/i)).toBeInTheDocument();
      });
    });

    it('offers "Start over" when error is NO_PENDING_DELETE_ACCOUNT', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        Object.assign(new Error('expired'), { code: 'NO_PENDING_DELETE_ACCOUNT' })
      );
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /start over/i }));

      expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
    });

    it('uses destructive variant on the final delete button', async () => {
      await advanceToFinalStep();
      const button = screen.getByRole('button', { name: /delete account permanently/i });
      // shadcn destructive variant adds bg-destructive class
      expect(button.className).toMatch(/destructive/);
    });

    it('Back from final step with 2FA returns to TOTP step', async () => {
      const user = await advanceToFinalStep({ withTotp: true });
      await user.click(screen.getByRole('button', { name: /back/i }));
      expect(screen.getByTestId('otp-input')).toBeInTheDocument();
    });

    it('Back from final step without 2FA returns to password step', async () => {
      const user = await advanceToFinalStep();
      await user.click(screen.getByRole('button', { name: /back/i }));
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });

    it('renders generic INTERNAL error when finish rejects without an error code', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(new Error('boom'));
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
      });
    });

    it('renders generic INTERNAL error when init rejects without an error code', async () => {
      mockInitMutateAsync.mockRejectedValueOnce(new Error('boom'));
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'pw');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
      });
    });
  });

  describe('state reset', () => {
    it('resets to step 1 when modal reopens', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<DeleteAccountModal open={true} onOpenChange={vi.fn()} />, {
        wrapper: createWrapper(),
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));
      expect(screen.getByLabelText('Password')).toBeInTheDocument();

      rerender(<DeleteAccountModal open={false} onOpenChange={vi.fn()} />);
      act(() => {
        rerender(<DeleteAccountModal open={true} onOpenChange={vi.fn()} />);
      });

      expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
    });
  });
});
