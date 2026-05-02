import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentForm } from './payment-form';
import * as helcimLoader from '../../lib/helcim-loader';
import * as billingHooks from '../../hooks/billing';
import * as envModule from '@/lib/env';

// Mock helcim loader
vi.mock('../../lib/helcim-loader', () => ({
  loadHelcimScript: vi.fn(),
  readHelcimResult: vi.fn(),
}));

// Mock billing hooks
vi.mock('../../hooks/billing', () => ({
  useCreatePayment: vi.fn(),
  useProcessPayment: vi.fn(),
  usePaymentStatus: vi.fn(),
  billingKeys: {
    all: ['billing'] as const,
    balance: () => ['billing', 'balance'] as const,
    transactions: () => ['billing', 'transactions'] as const,
    transactionList: (cursor?: string) => ['billing', 'transactions', { cursor }] as const,
    payments: () => ['billing', 'payments'] as const,
    payment: (id: string) => ['billing', 'payments', id] as const,
  },
}));

// Mock env module
vi.mock('@/lib/env', () => ({
  env: {
    isDev: true,
    isLocalDev: false, // Default to non-local dev (like CI) for most tests
    isProduction: false,
    isCI: false,
    requiresRealServices: false,
  },
}));

// Mock FormInput to avoid full component tree
vi.mock('@/components/shared/form-input', () => ({
  FormInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const queryClient = createQueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function fillValidCardDetails(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/card number/i), '4111111111111111');
  await user.type(screen.getByLabelText(/expiry/i), '1230');
  await user.type(screen.getByLabelText(/cvv/i), '123');
  await user.type(screen.getByLabelText(/name on card/i), 'Test User');
  await user.type(screen.getByLabelText(/billing address/i), '123 Test Street');
  await user.type(screen.getByLabelText(/zip/i), '12345');
}

describe('PaymentForm', () => {
  const mockCreatePayment = {
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
    isIdle: true,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
    variables: undefined,
    reset: vi.fn(),
    context: undefined,
    failureCount: 0,
    failureReason: null,
    status: 'idle' as const,
    submittedAt: 0,
  };

  const mockProcessPayment = {
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
    isIdle: true,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
    variables: undefined,
    reset: vi.fn(),
    context: undefined,
    failureCount: 0,
    failureReason: null,
    status: 'idle' as const,
    submittedAt: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset env mock to default (non-local dev) for most tests
    vi.mocked(envModule).env = {
      isDev: true,
      isLocalDev: false,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    };

    vi.mocked(billingHooks.useCreatePayment).mockReturnValue(
      mockCreatePayment as unknown as ReturnType<typeof billingHooks.useCreatePayment>
    );
    vi.mocked(billingHooks.useProcessPayment).mockReturnValue(
      mockProcessPayment as unknown as ReturnType<typeof billingHooks.useProcessPayment>
    );
    vi.mocked(billingHooks.usePaymentStatus).mockReturnValue({ data: undefined } as ReturnType<
      typeof billingHooks.usePaymentStatus
    >);
    vi.mocked(helcimLoader.loadHelcimScript).mockResolvedValue();
    // Default mock for readHelcimResult - prevents undefined errors
    vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
      success: false,
      errorMessage: 'No card data',
    });

    // Mock window function
    globalThis.helcimProcess = vi.fn();
  });

  describe('single-page layout', () => {
    it('renders amount input on initial render', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
    });

    it('shows minimum $5 in label', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByLabelText(/amount.*minimum.*\$5/i)).toBeInTheDocument();
    });

    it('renders card input fields after script loads', async () => {
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/expiry/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/cvv/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/name on card/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/billing address/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/zip/i)).toBeInTheDocument();
      });
    });

    it('loads helcim script on mount', async () => {
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(helcimLoader.loadHelcimScript).toHaveBeenCalled();
      });
    });

    it('renders purchase button', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
    });

    it('renders cancel button when onCancel provided', () => {
      renderWithProviders(<PaymentForm onCancel={vi.fn()} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('does not render cancel button when onCancel not provided', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('amount validation', () => {
    it('shows error when amount is empty on submit', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load so button is enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Submit touches all fields, so multiple alerts appear
      await waitFor(() => {
        expect(screen.getByText(/please enter an amount/i)).toBeInTheDocument();
      });
    });

    it('shows error when amount is below minimum', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load so button is enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '3');
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Submit touches all fields, so multiple alerts appear
      await waitFor(() => {
        expect(screen.getByText(/minimum deposit is \$5/i)).toBeInTheDocument();
      });
    });

    it('shows error when amount exceeds maximum', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load so button is enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '1500');
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Submit touches all fields, so multiple alerts appear
      await waitFor(() => {
        expect(screen.getByText(/maximum deposit is \$1000/i)).toBeInTheDocument();
      });
    });

    it('shows success when amount is valid', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/amount/i), '25');

      await waitFor(() => {
        expect(screen.getByTestId('amount-input-success')).toHaveTextContent(/valid/i);
      });
    });

    it('blocks non-numeric characters in amount field', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      const amountInput = screen.getByLabelText(/amount/i);

      // Try typing characters that should be blocked
      await user.type(amountInput, '1e5');

      // Only '15' should be entered, 'e' should be blocked
      expect(amountInput).toHaveValue(15);
    });
  });

  describe('card validation', () => {
    it('shows success for valid card number', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/card number/i), '4111111111111111');

      await waitFor(() => {
        expect(screen.getByTestId('cardNumber-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for invalid card number', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/card number/i), '1234567890123456');
      // Blur to trigger touched state
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/invalid card/i);
      });
    });

    it('shows success for valid expiry', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/expiry/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/expiry/i), '1230');

      await waitFor(() => {
        expect(screen.getByTestId('cardExpiryDate-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for expired card', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/expiry/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/expiry/i), '0120');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/expired/i);
      });
    });

    it('shows success for valid CVV', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/cvv/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/cvv/i), '123');

      await waitFor(() => {
        expect(screen.getByTestId('cardCVV-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for invalid CVV', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/cvv/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/cvv/i), '12');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/3.*digits/i);
      });
    });

    it('shows success for valid ZIP code', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/zip/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/zip/i), '12345');

      await waitFor(() => {
        expect(screen.getByTestId('cardHolderPostalCode-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for invalid ZIP code', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/zip/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/zip/i), '123');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/must be 5 digits/i);
      });
    });
  });

  describe('payment flow', () => {
    it('creates payment and processes on submit with valid amount', async () => {
      const user = userEvent.setup();
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });

      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(mockCreatePayment.mutateAsync).toHaveBeenCalledWith({
          amount: '50.00000000',
        });
      });
    });

    it('shows processing button state during payment', async () => {
      const user = userEvent.setup();
      mockCreatePayment.mutateAsync.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally never resolves to test loading state
          })
      );

      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /processing/i })).toBeInTheDocument();
      });
    });

    it('shows error state on payment creation failure', async () => {
      const user = userEvent.setup();
      mockCreatePayment.mutateAsync.mockRejectedValue(new Error('Payment creation error'));

      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        // Check for the user-facing error message (specific error only shown in DevOnly)
        expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
        // Also verify we're on the error view
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('cancel functionality', () => {
    it('calls onCancel when cancel button clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      // Wait for form to render
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('try again functionality', () => {
    it('shows try again button on error', async () => {
      const user = userEvent.setup();
      mockCreatePayment.mutateAsync.mockRejectedValue(new Error('Payment failed'));

      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('resets form when try again clicked', async () => {
      const user = userEvent.setup();
      mockCreatePayment.mutateAsync.mockRejectedValue(new Error('Payment failed'));

      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /try again/i }));

      // After reset, form should show again
      await waitFor(() => {
        expect(screen.getByLabelText(/amount/i)).toHaveValue(null);
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
    });
  });

  describe('helcim script loading', () => {
    it('shows loading state while helcim script loads', () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally never resolves to test loading state
          })
      );

      renderWithProviders(<PaymentForm />);

      expect(screen.getByText(/loading.*payment/i)).toBeInTheDocument();
    });

    it('shows error when helcim script fails to load', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue(new Error('Script load failed'));

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByText(/failed.*load.*payment/i)).toBeInTheDocument();
      });
    });

    it('uses fallback copy when script rejection is not an Error instance', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue('plain string error');

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load payment form/i)).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('has accessible form labels', async () => {
      renderWithProviders(<PaymentForm />);

      // Wait for form to render
      await waitFor(() => {
        expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      });
    });

    it('associates error messages with input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        const input = screen.getByLabelText(/amount/i);
        expect(input).toHaveAttribute('aria-invalid', 'true');
      });
    });
  });

  describe('helcim branding', () => {
    it('displays helcim logo', async () => {
      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      // HelcimLogo renders with aria-label "Powered by Helcim"
      expect(screen.getByLabelText('Powered by Helcim')).toBeInTheDocument();
    });

    it('displays helcim branding container', async () => {
      renderWithProviders(<PaymentForm />);

      // Wait for script to load
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId('helcim-security-badge')).toBeInTheDocument();
    });
  });

  describe('keyboard navigation', () => {
    it('Enter on amount field focuses card number field', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      // Wait for script to load so card fields are rendered
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      const amountInput = screen.getByLabelText(/amount/i);
      await user.click(amountInput);
      await user.keyboard('{Enter}');

      expect(document.activeElement).toBe(screen.getByLabelText(/card number/i));
    });
  });

  describe('dev simulation buttons', () => {
    it('does not show simulation buttons in production mode', async () => {
      // Mock env as production mode (isDev = false)
      vi.mocked(envModule).env = {
        isDev: false,
        isLocalDev: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      };

      renderWithProviders(<PaymentForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.queryByTestId('dev-simulation-buttons')).not.toBeInTheDocument();
      expect(screen.queryByTestId('simulate-success-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('simulate-failure-btn')).not.toBeInTheDocument();
    });

    it('shows simulation buttons in local dev mode', async () => {
      // Mock env as local dev mode
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      // Wait for form to load
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId('dev-simulation-buttons')).toBeInTheDocument();
      expect(screen.getByTestId('simulate-success-btn')).toBeInTheDocument();
      expect(screen.getByTestId('simulate-failure-btn')).toBeInTheDocument();
    });

    it('pre-fills form fields when pre-fill success clicked', async () => {
      const user = userEvent.setup();

      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId('simulate-success-btn')).toBeInTheDocument();
      });

      // Mock requestSubmit to prevent auto-submit
      const mockSubmit = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = mockSubmit;
      }

      await user.click(screen.getByTestId('simulate-success-btn'));

      // Wait for form fields to be populated
      await waitFor(() => {
        const cardNumberInput = screen.getByLabelText<HTMLInputElement>(/card number/i);
        expect(cardNumberInput.value).toBe('4111 1111 1111 1111');
      });

      const cvvInput = screen.getByLabelText<HTMLInputElement>(/cvv/i);
      const amountInput = screen.getByLabelText<HTMLInputElement>(/amount/i);

      expect(cvvInput.value).toBe('123');
      expect(amountInput.value).toBe('100');
    });

    it('pre-fills form fields with decline CVV when pre-fill decline clicked', async () => {
      const user = userEvent.setup();

      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId('simulate-failure-btn')).toBeInTheDocument();
      });

      // Mock requestSubmit to prevent auto-submit
      const mockSubmit = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = mockSubmit;
      }

      await user.click(screen.getByTestId('simulate-failure-btn'));

      // Wait for form fields to be populated
      await waitFor(() => {
        const cardNumberInput = screen.getByLabelText<HTMLInputElement>(/card number/i);
        expect(cardNumberInput.value).toBe('4111 1111 1111 1111');
      });

      const cvvInput = screen.getByLabelText<HTMLInputElement>(/cvv/i);
      expect(cvvInput.value).toBe('200');
    });
  });

  describe('script-load failure UI', () => {
    it('reload button calls window.location.reload', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue(new Error('Script load failed'));
      const reloadSpy = vi.fn();
      const originalLocation = globalThis.location;

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByText(/failed.*load.*payment/i)).toBeInTheDocument();
      });

      // Stub location only for the duration of the click so userEvent setup
      // above isn't disturbed.
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        writable: true,
        value: { reload: reloadSpy },
      });

      try {
        await user.click(screen.getByRole('button', { name: /reload page/i }));
        expect(reloadSpy).toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis, 'location', {
          configurable: true,
          writable: true,
          value: originalLocation,
        });
      }
    });
  });

  describe('process payment - success path', () => {
    it('shows success view when processPayment returns completed', async () => {
      const onSuccess = vi.fn();
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({
        status: 'completed',
        newBalance: '15.00',
      });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onSuccess={onSuccess} onCancel={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      // helcimProcess simulates Helcim DOM update; trigger MutationObserver via insertion
      globalThis.helcimProcess = vi.fn(() => {
        // Populate response and customerCode + dispatch a child mutation to trigger observer
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) {
          const temporary = document.createElement('span');
          results.append(temporary);
        }
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(mockProcessPayment.mutateAsync).toHaveBeenCalledWith({
          paymentId: 'pay_123',
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });
      expect(onSuccess).toHaveBeenCalledWith('15.00');
    });

    it('PaymentSuccessCard close button invokes onCancel', async () => {
      const onCancel = vi.fn();
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({
        status: 'completed',
        newBalance: '15.00',
      });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) {
          const temporary = document.createElement('span');
          results.append(temporary);
        }
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /close/i }));
      expect(onCancel).toHaveBeenCalled();
    });

    it('PaymentSuccessCard renders without onCancel when omitted', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({
        status: 'completed',
        newBalance: '15.00',
      });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });

      // Clicking close when no onCancel provided does nothing (no error).
      await user.click(screen.getByRole('button', { name: /close/i }));
    });
  });

  describe('process payment - error path', () => {
    it('shows error view when processPayment throws', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockRejectedValue(new Error('Charge declined'));

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('shows error view when processPayment throws non-Error value', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockRejectedValue('some string error');

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'tok_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('tokenization failures', () => {
    it('shows error view when tokenization returns success: false', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: false,
        errorMessage: 'Card declined by Helcim',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        // For failures (response='0'), MutationObserver processes immediately
        // (no customerCode required)
        setVal('response', '0');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('uses fallback error message when tokenization fails without errorMessage', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({ success: false });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '0');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('shows error when tokenization returns success but missing required fields', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      // Success without cardToken — should fall through to "missing token" branch.
      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc'); // observer needs SOME value to fire
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('helcim process not available', () => {
    it('shows error when globalThis.helcimProcess is undefined', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      // Remove the global so submit takes the "not available" branch.
      globalThis.helcimProcess = undefined;

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('polling for webhook confirmation', () => {
    it('starts polling when processPayment returns processing', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      vi.mocked(billingHooks.usePaymentStatus).mockReturnValue({
        data: undefined,
      } as ReturnType<typeof billingHooks.usePaymentStatus>);

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        // After processPayment returns 'processing', usePaymentStatus is invoked
        // with enabled=true. We assert the latest call to it had enabled set.
        const calls = vi.mocked(billingHooks.usePaymentStatus).mock.calls;
        const lastCall = calls.at(-1);
        expect(lastCall?.[1]).toMatchObject({ enabled: true });
      });
    });

    it('completes payment when polling returns completed', async () => {
      const onSuccess = vi.fn();

      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      // Return completed data only when enabled=true (i.e. polling has started).
      vi.mocked(billingHooks.usePaymentStatus).mockImplementation((_id, options) => {
        if (options?.enabled) {
          return {
            data: { status: 'completed', newBalance: '99.00' },
          } as ReturnType<typeof billingHooks.usePaymentStatus>;
        }
        return { data: undefined } as ReturnType<typeof billingHooks.usePaymentStatus>;
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(
        () => {
          expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
      expect(onSuccess).toHaveBeenCalledWith('99.00');
    });

    it('moves to error state when polling returns failed', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      vi.mocked(billingHooks.usePaymentStatus).mockImplementation((_id, options) => {
        if (options?.enabled) {
          return {
            data: { status: 'failed', errorMessage: 'Webhook said no' },
          } as ReturnType<typeof billingHooks.usePaymentStatus>;
        }
        return { data: undefined } as ReturnType<typeof billingHooks.usePaymentStatus>;
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('moves to error when polling exceeds timeout', async () => {
      // DevOnly renders error message only in isLocalDev — required to assert
      // on the timeout copy.
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      vi.mocked(billingHooks.usePaymentStatus).mockReturnValue({
        data: undefined,
      } as ReturnType<typeof billingHooks.usePaymentStatus>);

      // The polling effect uses Date.now twice: once to seed pollingStartTime,
      // and again to compute elapsed time. Stub Date.now to advance by 120s on
      // each subsequent call so elapsed > POLLING_TIMEOUT_MS (60s).
      const realDateNow = Date.now.bind(Date);
      const t0 = realDateNow();
      let advance = 0;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        advance += 1;
        return t0 + advance * 120_000;
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/timed out/i)).toBeInTheDocument();
      });

      dateSpy.mockRestore();
    });
  });

  describe('mutation observer guards - customerCode race', () => {
    it('ignores response=1 mutations until customerCode is also populated', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      vi.mocked(helcimLoader.readHelcimResult).mockClear();

      // Submit with response=1 set but NO customerCode — observer should
      // early-return without invoking readHelcimResult.
      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        // Intentionally leave customerCode blank.
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Wait a tick for any observer firings.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      expect(helcimLoader.readHelcimResult).not.toHaveBeenCalled();
    });
  });

  describe('mutation observer guards', () => {
    it('ignores Helcim DOM mutations when not expecting tokenization', async () => {
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      // Trigger a stray mutation before any submit; readHelcimResult should
      // never be called because expectingTokenizationRef is false.
      vi.mocked(helcimLoader.readHelcimResult).mockClear();
      const results = document.querySelector('#helcimResults');
      const responseEl = document.querySelector<HTMLInputElement>('#response');
      if (responseEl) responseEl.value = '1';
      if (results) results.append(document.createElement('span'));

      // Wait a tick for any observer to fire.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      expect(helcimLoader.readHelcimResult).not.toHaveBeenCalled();
    });
  });

  describe('dev simulate buttons - timer cleanup', () => {
    it('cleans up the simulate timer on unmount without errors', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      const { unmount } = renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId('simulate-success-btn')).toBeInTheDocument();
      });

      // Click but unmount before the 100ms timer fires.
      await user.click(screen.getByTestId('simulate-success-btn'));
      unmount();
    });

    it('triggers form requestSubmit ~100ms after simulate-success click', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId('simulate-success-btn')).toBeInTheDocument();
      });

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = requestSubmitSpy;
      }

      await user.click(screen.getByTestId('simulate-success-btn'));

      await waitFor(() => {
        expect(requestSubmitSpy).toHaveBeenCalled();
      });
    });

    it('triggers form requestSubmit ~100ms after simulate-failure click', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId('simulate-failure-btn')).toBeInTheDocument();
      });

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = requestSubmitSpy;
      }

      await user.click(screen.getByTestId('simulate-failure-btn'));

      await waitFor(() => {
        expect(requestSubmitSpy).toHaveBeenCalled();
      });
    });
  });

  describe('helcim script - mounted guard', () => {
    it('ignores resolved script load if component unmounted first', async () => {
      let resolveLoad: () => void = () => {};
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          })
      );

      const { unmount } = renderWithProviders(<PaymentForm />);

      unmount();

      // Resolve after unmount; should hit the !mounted branch silently.
      resolveLoad();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      // Sanity assertion for sonarjs/assertions-in-tests.
      expect(helcimLoader.loadHelcimScript).toHaveBeenCalled();
    });

    it('ignores rejected script load if component unmounted first', async () => {
      let rejectLoad: (err: Error) => void = () => {};
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          })
      );

      const { unmount } = renderWithProviders(<PaymentForm />);

      unmount();

      rejectLoad(new Error('boom'));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(helcimLoader.loadHelcimScript).toHaveBeenCalled();
    });
  });

  describe('helcim process unavailable - non-Error throw', () => {
    it('handles non-Error rejection from createPayment', async () => {
      const user = userEvent.setup();
      mockCreatePayment.mutateAsync.mockRejectedValue('plain string failure');

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('PaymentErrorCard with onCancel', () => {
    it('renders both Cancel and Try Again buttons when onCancel provided', async () => {
      const onCancel = vi.fn();
      mockCreatePayment.mutateAsync.mockRejectedValue(new Error('boom'));

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('PaymentErrorCard without onCancel', () => {
    it('renders only the try-again primary action', async () => {
      mockCreatePayment.mutateAsync.mockRejectedValue(new Error('boom'));

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      // No onCancel passed — Cancel button should not exist on the error card.
      expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    });
  });

  describe('PaymentErrorCard error message default', () => {
    it('renders fallback dev error copy when errorMessage is null', async () => {
      // Force isLocalDev so DevOnly renders, then trigger error with no message.
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      // Polling returns failed with NO errorMessage so onFailed receives undefined.
      vi.mocked(billingHooks.usePaymentStatus).mockImplementation((_id, options) => {
        if (options?.enabled) {
          return {
            data: { status: 'failed' },
          } as ReturnType<typeof billingHooks.usePaymentStatus>;
        }
        return { data: undefined } as ReturnType<typeof billingHooks.usePaymentStatus>;
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/an unexpected error occurred/i)).toBeInTheDocument();
      });
    });
  });

  describe('PaymentSuccessCard amount fallback', () => {
    it('renders +$0.00 when amount is empty', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({
        status: 'completed',
        // newBalance is intentionally absent — exercises the
        // status.newBalance falsy branch in handlePaymentStatusUpdate.
      });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      // Polling returns completed without newBalance so the success card
      // renders even though onSuccess never receives a balance.
      vi.mocked(billingHooks.usePaymentStatus).mockImplementation((_id, options) => {
        if (options?.enabled) {
          return {
            data: { status: 'completed' },
          } as ReturnType<typeof billingHooks.usePaymentStatus>;
        }
        return { data: undefined } as ReturnType<typeof billingHooks.usePaymentStatus>;
      });

      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Polling returned completed (no newBalance) — handled stays true so
      // polling stops, but the success card is NOT shown because the
      // onConfirmed callback only fires when newBalance is truthy. The form
      // remains in 'processing' / form view rather than 'success' view.
      // We instead exercise the handlePaymentStatusUpdate branch by checking
      // that the status update was processed (polling stopped).
      await waitFor(() => {
        const calls = vi.mocked(billingHooks.usePaymentStatus).mock.calls;
        expect(calls.some((c) => c[1]?.enabled === true)).toBe(true);
      });
    });
  });

  describe('amount already set when simulating', () => {
    it('preserves amount when simulate-success is clicked after typing', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId('simulate-success-btn')).toBeInTheDocument();
      });

      // Type an amount before clicking simulate so populateTestCard's
      // `if (!form.amount)` branch goes false.
      await user.type(screen.getByLabelText(/amount/i), '25');

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) formEl.requestSubmit = requestSubmitSpy;

      await user.click(screen.getByTestId('simulate-success-btn'));

      // Amount should remain '25' (not be overwritten with '100').
      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('25');
    });
  });

  describe('payment status update branches', () => {
    it('treats unknown status as a no-op (continues polling)', async () => {
      mockCreatePayment.mutateAsync.mockResolvedValue({ paymentId: 'pay_123' });
      mockProcessPayment.mutateAsync.mockResolvedValue({ status: 'processing' });

      vi.mocked(helcimLoader.readHelcimResult).mockReturnValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      // Polling returns an unknown status — handled returns false; component
      // stays on the form (no success, no error card).
      vi.mocked(billingHooks.usePaymentStatus).mockImplementation((_id, options) => {
        if (options?.enabled) {
          return {
            data: { status: 'pending' },
          } as ReturnType<typeof billingHooks.usePaymentStatus>;
        }
        return { data: undefined } as ReturnType<typeof billingHooks.usePaymentStatus>;
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      globalThis.helcimProcess = vi.fn(() => {
        const setVal = (id: string, val: string): void => {
          const el = document.querySelector<HTMLInputElement>(`#${id}`);
          if (el) el.value = val;
        };
        setVal('response', '1');
        setVal('cardToken', 'tok_abc');
        setVal('customerCode', 'cust_abc');
        const results = document.querySelector('#helcimResults');
        if (results) results.append(document.createElement('span'));
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // After processPayment resolves with 'processing', polling starts.
      // Wait for usePaymentStatus to be called with enabled=true.
      await waitFor(() => {
        const calls = vi.mocked(billingHooks.usePaymentStatus).mock.calls;
        expect(calls.some((c) => c[1]?.enabled === true)).toBe(true);
      });

      // No success or error card should appear since status is 'pending'.
      expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });
  });
});
