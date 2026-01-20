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
    window.helcimProcess = vi.fn();
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
    // Helper to fill in valid card details
    async function fillValidCardDetails(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.type(screen.getByLabelText(/card number/i), '4111111111111111');
      await user.type(screen.getByLabelText(/expiry/i), '1230');
      await user.type(screen.getByLabelText(/cvv/i), '123');
      await user.type(screen.getByLabelText(/name on card/i), 'Test User');
      await user.type(screen.getByLabelText(/billing address/i), '123 Test Street');
      await user.type(screen.getByLabelText(/zip/i), '12345');
    }

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
    // Helper to fill in valid card details
    async function fillValidCardDetails(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.type(screen.getByLabelText(/card number/i), '4111111111111111');
      await user.type(screen.getByLabelText(/expiry/i), '1230');
      await user.type(screen.getByLabelText(/cvv/i), '123');
      await user.type(screen.getByLabelText(/name on card/i), 'Test User');
      await user.type(screen.getByLabelText(/billing address/i), '123 Test Street');
      await user.type(screen.getByLabelText(/zip/i), '12345');
    }

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
      const formEl = document.getElementById('helcimForm') as HTMLFormElement | null;
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
      const formEl = document.getElementById('helcimForm') as HTMLFormElement | null;
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
});
