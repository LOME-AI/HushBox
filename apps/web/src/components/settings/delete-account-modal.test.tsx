import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { makeBalance } from '@/test-utils/balance-fixture';
// Mirror of the production ApiError shape — avoid importing from @/lib/api/api so
// the test doesn't depend on VITE_API_URL being set in the test env.
const { ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return { ApiError };
});

vi.mock('@/lib/api/api', () => ({
  ApiError,
  getErrorBody: (
    error: unknown
  ): { code: string; details?: Record<string, unknown> } | undefined => {
    if (!(error instanceof ApiError)) return undefined;
    const data = error.data;
    if (data !== null && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      const code = typeof record['code'] === 'string' ? record['code'] : error.message;
      const rawDetails = record['details'];
      const details =
        rawDetails !== null && typeof rawDetails === 'object'
          ? (rawDetails as Record<string, unknown>)
          : undefined;
      return details === undefined ? { code } : { code, details };
    }
    return { code: error.message };
  },
}));

function apiError(
  code: string,
  status = 400,
  details?: Record<string, unknown>
): InstanceType<typeof ApiError> {
  return new ApiError(code, status, details === undefined ? { code } : { code, details });
}

import { DeleteAccountModal } from './delete-account-modal';
import type { clearLocalAuthState } from '@/lib/auth/auth';

const { mockInitMutateAsync, mockFinishMutateAsync } = vi.hoisted(() => ({
  mockInitMutateAsync: vi.fn((_args: unknown) => Promise.resolve({ ke2: [] as number[] })),
  mockFinishMutateAsync: vi.fn((_args: unknown) => Promise.resolve()),
}));

vi.mock('@/hooks/auth/use-delete-account', () => ({
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

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: () => mockUseBalance(),
}));

const { mockUseAuthUser } = vi.hoisted(() => ({
  mockUseAuthUser: vi.fn(),
}));

vi.mock('@/lib/auth/auth', () => ({
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
  clearLocalAuthState: mockClearLocalAuthState,
}));

const { mockClearLocalAuthState } = vi.hoisted(() => ({
  mockClearLocalAuthState: vi.fn(),
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
    mockUseBalance.mockReturnValue({ data: makeBalance('0') });
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

    it('draws the dialog at the 28rem width', () => {
      renderModal();

      const content = screen.getByTestId(TEST_IDS.deleteAccountModal);
      expect(content).toHaveClass('max-w-md');
      expect(content.className).not.toMatch(/w-\[75vw\]/);
    });

    it('introduces the list of what is deleted from the servers', () => {
      renderModal();
      expect(screen.getByText('This deletes, from our servers:')).toBeInTheDocument();
    });

    it.each([
      'Every conversation you own, group chats included. Their members lose them too.',
      'Your files, custom instructions and settings.',
      'Your encryption keys. Your recovery phrase stops working.',
    ])('lists "%s" as a deleted item', (item) => {
      renderModal();
      const list = screen.getByRole('list');
      expect(within(list).getByText(item).closest('li')).not.toBeNull();
    });

    it('draws an icon beside each deleted item', () => {
      renderModal();
      const items = within(screen.getByRole('list')).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      }
    });

    it('closes the intro with the muted retention and irreversibility line', () => {
      renderModal();
      const line = screen.getByText(
        "Billing records are kept for tax law, with your name and email removed. You're signed out everywhere. This can't be undone."
      );
      expect(line).toHaveClass('text-muted-foreground');
    });

    it('marks the intro Cancel with its test id', () => {
      renderModal();
      expect(screen.getByTestId(TEST_IDS.deleteAccountCancel)).toHaveAccessibleName('Cancel');
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

    it('treats a zero purchased balance as no wallet (free allowance is not spendable credit) and skips the wallet step', async () => {
      mockUseBalance.mockReturnValue({ data: makeBalance('0', '5000000000') });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
    });
  });

  describe('Step 2: Wallet balance (conditional)', () => {
    it('skips wallet step when balance is zero', async () => {
      mockUseBalance.mockReturnValue({ data: makeBalance('0') });
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
        data: makeBalance('12340000000'),
      });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getAllByText(/\$12\.34/).length).toBeGreaterThan(0);
      expect(screen.getByRole('checkbox', { name: /forfeit/i })).toBeInTheDocument();
    });

    it('disables Continue until forfeit checkbox is checked', async () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('12340000000'),
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
        data: makeBalance('12340000000'),
      });
      const user = renderModal();

      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
    });

    async function advanceToWalletStep(): Promise<ReturnType<typeof userEvent.setup>> {
      mockUseBalance.mockReturnValue({ data: makeBalance('12480000000') });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      return user;
    }

    it('titles the wallet step "Your balance is forfeited"', async () => {
      await advanceToWalletStep();
      expect(
        screen.getByRole('heading', { name: 'Your balance is forfeited' })
      ).toBeInTheDocument();
    });

    it('shows the balance under its "Your balance" caption in the mono face', async () => {
      await advanceToWalletStep();
      const caption = screen.getByText('Your balance');
      const amount = screen.getByText('$12.48');
      expect(caption.nextElementSibling).toBe(amount);
      expect(amount).toHaveClass('font-mono');
    });

    it('explains that credit cannot be refunded or moved', async () => {
      await advanceToWalletStep();
      expect(
        screen.getByText(
          "Credit can't be refunded or moved to another account. To use it first, close this and come back later."
        )
      ).toBeInTheDocument();
    });

    it('labels the forfeit checkbox with the balance', async () => {
      await advanceToWalletStep();
      expect(
        screen.getByRole('checkbox', {
          name: "I understand the $12.48 balance is forfeited and can't be refunded.",
        })
      ).toBeInTheDocument();
    });

    it('puts the forfeit test id on the checkbox control', async () => {
      await advanceToWalletStep();
      expect(screen.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox)).toHaveAttribute(
        'role',
        'checkbox'
      );
    });

    it('offers Back and Continue, and no Cancel, on the wallet step', async () => {
      await advanceToWalletStep();
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.deleteAccountWalletContinue)).toHaveAccessibleName(
        'Continue'
      );
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('draws the wallet Back in the footer beside Continue, not in the corner', async () => {
      await advanceToWalletStep();
      const back = screen.getByRole('button', { name: 'Back' });
      const continueButton = screen.getByTestId(TEST_IDS.deleteAccountWalletContinue);
      expect(back.parentElement).toBe(continueButton.parentElement);
    });

    it('Continue from wallet step advances to password step', async () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('12340000000'),
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
      mockInitMutateAsync.mockRejectedValueOnce(apiError('INCORRECT_PASSWORD'));
      const user = await advanceToPasswordStep();

      await user.type(screen.getByLabelText('Password'), 'wrongpw');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/incorrect password/i)).toBeInTheDocument();
      });
    });

    it('clears the password error when the field is edited', async () => {
      mockInitMutateAsync.mockRejectedValueOnce(apiError('INCORRECT_PASSWORD'));
      const user = await advanceToPasswordStep();

      await user.type(screen.getByLabelText('Password'), 'wrongpw');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => {
        expect(screen.getByText(/incorrect password/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Password'), 'x');

      await waitFor(() => {
        expect(screen.queryByText(/incorrect password/i)).not.toBeInTheDocument();
      });
    });

    it('formats a server-provided lockout countdown on the password step', async () => {
      mockInitMutateAsync.mockRejectedValueOnce(
        apiError('DELETE_ACCOUNT_LOCKED', 403, { retryAfterSeconds: 7200 })
      );
      const user = await advanceToPasswordStep();
      await user.type(screen.getByLabelText('Password'), 'pw');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/try again in 2 hours/i)).toBeInTheDocument();
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
        data: makeBalance('5000000000'),
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
        expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
      });
      return user;
    }

    it('shows the OTP input when user has 2FA', async () => {
      await advanceToTotpStep();
      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
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
      expect(screen.queryByTestId(TEST_IDS.otpInput)).not.toBeInTheDocument();
    });

    it('advances to final step after entering 6 digits', async () => {
      const user = await advanceToTotpStep();
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
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
          expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
        });
        const otpInput = screen.getByTestId(TEST_IDS.otpInput);
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

    it('submits, redirects to /welcome, and clears local state on 204', async () => {
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(mockFinishMutateAsync).toHaveBeenCalledWith({
          ke3: [4, 5, 6],
          confirmationPhrase: 'delete my account',
          acknowledgedForfeitNanoUsd: '0',
        });
      });

      await waitFor(() => {
        expect(globalThis.location.href).toBe('/welcome');
      });
      expect(mockClearLocalAuthState).toHaveBeenCalled();
    });

    it('assigns location.href before clearLocalAuthState so the navigation commits before queryClient.clear settles the app', async () => {
      let hrefWhenCleared: string | undefined;
      mockClearLocalAuthState.mockImplementation(() => {
        hrefWhenCleared = globalThis.location.href;
      });

      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(mockClearLocalAuthState).toHaveBeenCalled();
      });

      expect(hrefWhenCleared).toBe('/welcome');
    });

    it('does not reload the current document after a successful deletion so the /welcome navigation commits', async () => {
      const reloadSpy = vi.fn();
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        writable: true,
        value: { href: '', reload: reloadSpy },
      });
      // Mirror auth.ts clearLocalAuthState: it reloads the CURRENT url unless
      // told a navigation follows. A reload of /settings after href was set to
      // /welcome would override the pending nav and bounce the guard to /login.
      mockClearLocalAuthState.mockImplementationOnce(
        ({ next = 'reload' }: Parameters<typeof clearLocalAuthState>[0] = {}) => {
          if (next === 'reload') globalThis.location.reload();
        }
      );

      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(mockClearLocalAuthState).toHaveBeenCalledWith({ next: 'navigate-away' });
      });
      expect(globalThis.location.href).toBe('/welcome');
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('formats the lockout countdown when the deletion gate returns TOO_MANY_ATTEMPTS with retryAfterSeconds', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        apiError('TOO_MANY_ATTEMPTS', 429, { retryAfterSeconds: 600 })
      );
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByText(/try again in 10 minutes/i)).toBeInTheDocument();
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
          acknowledgedForfeitNanoUsd: '0',
        });
      });
    });

    it('routes INVALID_TOTP_CODE back to the TOTP step with the error visible there', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(apiError('INVALID_TOTP_CODE'));
      const user = await advanceToFinalStep({ withTotp: true });
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
      });
      expect(screen.getByText(/that code is incorrect or has expired/i)).toBeInTheDocument();
    });

    it('routes TOTP_CODE_REQUIRED back to the TOTP step (client forgot to send the code)', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(apiError('TOTP_CODE_REQUIRED'));
      const user = await advanceToFinalStep({ withTotp: true });
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
      });
      expect(screen.getByText(/enter your two-factor authentication code/i)).toBeInTheDocument();
    });

    it('formats lockout countdown using server-provided retryAfterSeconds on the final step', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        apiError('DELETE_ACCOUNT_LOCKED', 403, { retryAfterSeconds: 600 })
      );
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByText(/try again in 10 minutes/i)).toBeInTheDocument();
      });
    });

    it("falls back to the code's own message when the lockout wait is malformed", async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        apiError('DELETE_ACCOUNT_LOCKED', 403, { retryAfterSeconds: 0 })
      );
      const user = await advanceToFinalStep();
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Too many deletion attempts. Try again later.')
        ).toBeInTheDocument();
      });
    });

    it('offers "Start over" when error is NO_PENDING_DELETE_ACCOUNT', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(apiError('NO_PENDING_DELETE_ACCOUNT'));
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
      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
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

  describe('balance loading guard', () => {
    it('disables the intro Continue button while balance is still loading', () => {
      mockUseBalance.mockReturnValue({ data: undefined, isPending: true });
      renderModal();
      expect(screen.getByTestId(TEST_IDS.deleteAccountIntroContinue)).toBeDisabled();
    });

    it('enables Continue once balance has loaded (zero balance, skip wallet step)', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0'),
        isPending: false,
      });
      renderModal();
      expect(screen.getByTestId(TEST_IDS.deleteAccountIntroContinue)).not.toBeDisabled();
    });
  });

  describe('accessibility', () => {
    it('links the password input to its alert via aria-describedby on error', async () => {
      mockInitMutateAsync.mockRejectedValueOnce(apiError('INCORRECT_PASSWORD'));
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'wrongpw');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/incorrect password/i)).toBeInTheDocument();
      });
      const input = screen.getByLabelText('Password');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const errorNode = describedBy ? document.querySelector(`#${describedBy}`) : null;
      expect(errorNode?.textContent).toMatch(/incorrect password/i);
    });

    it('links the confirmation input to its alert via aria-describedby on error', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(apiError('NO_PENDING_DELETE_ACCOUNT'));
      // Inline the advanceToFinalStep flow here so this test stays self-contained.
      mockUseAuthUser.mockReturnValue({ totpEnabled: false });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'pw');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(screen.getByText(/start again|deletion session/i)).toBeInTheDocument();
      });
      const input = screen.getByLabelText(/confirmation/i);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input.getAttribute('aria-describedby')).toBeTruthy();
    });
  });

  describe('step line', () => {
    const WITH_BALANCE = '12480000000';

    async function walkTo(
      target: 'intro' | 'wallet' | 'password' | 'totp' | 'final',
      options: { balance: boolean; totp: boolean }
    ): Promise<void> {
      mockUseBalance.mockReturnValue({ data: makeBalance(options.balance ? WITH_BALANCE : '0') });
      mockUseAuthUser.mockReturnValue({ totpEnabled: options.totp });
      const user = renderModal();
      if (target === 'intro') return;
      await user.click(screen.getByRole('button', { name: /continue/i }));
      if (options.balance) {
        if (target === 'wallet') return;
        await user.click(screen.getByRole('checkbox', { name: /forfeit/i }));
        await user.click(screen.getByRole('button', { name: /continue/i }));
      }
      if (target === 'password') return;
      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      if (options.totp) {
        await waitFor(() => {
          expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
        });
        if (target === 'totp') return;
        await user.click(screen.getByTestId(TEST_IDS.otpInput));
        await user.keyboard('123456');
        await user.click(screen.getByRole('button', { name: /continue/i }));
      }
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
    }

    it.each([
      { target: 'intro', balance: false, totp: false, line: 'Step 1 of 3' },
      { target: 'password', balance: false, totp: false, line: 'Step 2 of 3' },
      { target: 'final', balance: false, totp: false, line: 'Step 3 of 3' },
      { target: 'intro', balance: true, totp: false, line: 'Step 1 of 4' },
      { target: 'wallet', balance: true, totp: false, line: 'Step 2 of 4' },
      { target: 'password', balance: true, totp: false, line: 'Step 3 of 4' },
      { target: 'final', balance: true, totp: false, line: 'Step 4 of 4' },
      { target: 'intro', balance: false, totp: true, line: 'Step 1 of 4' },
      { target: 'totp', balance: false, totp: true, line: 'Step 3 of 4' },
      { target: 'final', balance: false, totp: true, line: 'Step 4 of 4' },
      { target: 'intro', balance: true, totp: true, line: 'Step 1 of 5' },
      { target: 'wallet', balance: true, totp: true, line: 'Step 2 of 5' },
      { target: 'password', balance: true, totp: true, line: 'Step 3 of 5' },
      { target: 'totp', balance: true, totp: true, line: 'Step 4 of 5' },
      { target: 'final', balance: true, totp: true, line: 'Step 5 of 5' },
    ] as const)(
      'reads $line on the $target step (balance: $balance, two-factor: $totp)',
      async ({ target, balance, totp, line }) => {
        await walkTo(target, { balance, totp });
        expect(screen.getByText(line)).toBeInTheDocument();
      }
    );

    it('writes no step text while the balance is loading', () => {
      mockUseBalance.mockReturnValue({ data: undefined, isPending: true });
      renderModal();
      expect(screen.queryByText(/^Step \d/)).not.toBeInTheDocument();
    });

    it('keeps the step line space, hidden from assistive technology, while the balance is loading', () => {
      mockUseBalance.mockReturnValue({ data: undefined, isPending: true });
      renderModal();
      const heading = screen.getByRole('heading', { name: 'Delete your account' });
      const space = heading.parentElement?.querySelector('[data-slot="overlay-step"]');
      expect(space).toHaveAttribute('aria-hidden', 'true');
      expect(space).toHaveClass('invisible');
    });
  });

  describe('navigation controls', () => {
    it.each([
      { target: 'wallet', balance: true, totp: false },
      { target: 'password', balance: true, totp: false },
      { target: 'totp', balance: false, totp: true },
      { target: 'final', balance: false, totp: false },
    ] as const)(
      'has exactly one control named Back on the $target step',
      async ({ target, balance, totp }) => {
        mockUseBalance.mockReturnValue({ data: makeBalance(balance ? '12480000000' : '0') });
        mockUseAuthUser.mockReturnValue({ totpEnabled: totp });
        const user = renderModal();
        await user.click(screen.getByRole('button', { name: /continue/i }));
        if (target !== 'wallet' && balance) {
          await user.click(screen.getByRole('checkbox', { name: /forfeit/i }));
          await user.click(screen.getByRole('button', { name: /continue/i }));
        }
        if (target === 'totp' || target === 'final') {
          await user.type(screen.getByLabelText('Password'), 'mypassword');
          await user.click(screen.getByRole('button', { name: /continue/i }));
          await waitFor(() => {
            expect(
              screen.getByText(target === 'totp' ? /verification code/i : /type delete my account/i)
            ).toBeInTheDocument();
          });
        }
        expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
      }
    );

    it('has no Back control on the intro', () => {
      renderModal();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('keeps the close control on the wallet step', async () => {
      mockUseBalance.mockReturnValue({ data: makeBalance('12480000000') });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      expect(document.querySelector('[data-slot="overlay-close"]')).not.toBeNull();
    });
  });

  describe('purchased-balance refusal', () => {
    const SERVER_BALANCE = '12480000000';

    function forfeitRefusal(details: Record<string, unknown>): InstanceType<typeof ApiError> {
      return apiError('DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED', 409, details);
    }

    async function submitFromFinalStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
      await user.type(screen.getByLabelText(/confirmation/i), 'delete my account');
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));
    }

    async function deleteWithoutShownBalance(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await submitFromFinalStep(user);
      return user;
    }

    it("shows the forfeit step with the server's figure when the server refuses", async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        forfeitRefusal({ purchasedBalanceNanoUsd: SERVER_BALANCE })
      );
      await deleteWithoutShownBalance();

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Your balance is forfeited' })
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole('checkbox', {
          name: "I understand the $12.48 balance is forfeited and can't be refunded.",
        })
      ).not.toBeChecked();
    });

    it('reaches the forfeit step through the refusal when the balance read errored', async () => {
      mockUseBalance.mockReturnValue({ data: undefined, isPending: false, isError: true });
      mockFinishMutateAsync.mockRejectedValueOnce(
        forfeitRefusal({ purchasedBalanceNanoUsd: SERVER_BALANCE })
      );
      await deleteWithoutShownBalance();

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Your balance is forfeited' })
        ).toBeInTheDocument();
      });
      expect(screen.getByText('$12.48')).toBeInTheDocument();
    });

    it("acknowledges the server's figure on the next attempt after the user ticks it", async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        forfeitRefusal({ purchasedBalanceNanoUsd: SERVER_BALANCE })
      );
      const user = await deleteWithoutShownBalance();
      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: /forfeit/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('checkbox', { name: /forfeit/i }));
      await user.click(screen.getByTestId(TEST_IDS.deleteAccountWalletContinue));
      await user.click(screen.getByTestId(TEST_IDS.deleteAccountPasswordContinue));
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /type delete my account/i })
        ).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /delete account permanently/i }));

      await waitFor(() => {
        expect(mockFinishMutateAsync).toHaveBeenLastCalledWith(
          expect.objectContaining({ acknowledgedForfeitNanoUsd: SERVER_BALANCE })
        );
      });
      expect(mockInitMutateAsync).toHaveBeenCalledTimes(2);
    });

    it('counts the forfeit step in the step line after the refusal', async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        forfeitRefusal({ purchasedBalanceNanoUsd: SERVER_BALANCE })
      );
      await deleteWithoutShownBalance();

      await waitFor(() => {
        expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
      });
    });

    it('sends the balance its forfeit step showed', async () => {
      mockUseBalance.mockReturnValue({ data: makeBalance(SERVER_BALANCE) });
      const user = renderModal();
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.click(screen.getByRole('checkbox', { name: /forfeit/i }));
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await user.type(screen.getByLabelText('Password'), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));
      await submitFromFinalStep(user);

      await waitFor(() => {
        expect(mockFinishMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ acknowledgedForfeitNanoUsd: SERVER_BALANCE })
        );
      });
      await waitFor(() => {
        expect(globalThis.location.href).toBe('/welcome');
      });
    });

    it("shows the refusal's own message when its figure is unreadable", async () => {
      mockFinishMutateAsync.mockRejectedValueOnce(
        forfeitRefusal({ purchasedBalanceNanoUsd: '12.48' })
      );
      await deleteWithoutShownBalance();

      await waitFor(() => {
        expect(
          screen.getByText(
            "You haven't confirmed forfeiting your account's credit. Review your balance, then try again."
          )
        ).toBeInTheDocument();
      });
      expect(screen.getByRole('heading', { name: /type delete my account/i })).toBeInTheDocument();
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
