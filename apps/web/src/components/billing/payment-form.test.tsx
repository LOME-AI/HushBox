import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS, ERROR_CODES, friendlyErrorMessage } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { renderWithProviders } from '@/test-utils/render';
import { makeBalance } from '@/test-utils/balance-fixture';
import * as envModule from '@/lib/platform/env';
import { ApiError } from '@/lib/api/api';
import { shouldRetryMutation, MAX_RETRIES } from '@/lib/api/retry';
import {
  markRequestKeyed,
  dispatchCountFor,
  dispatchFailuresFor,
} from '@/lib/api/idempotent-mutation';
import { client, fetchJson } from '@/lib/api-client.js';
import * as billingHooks from '@/hooks/billing/billing';
import { PaymentForm } from './payment-form';
import * as helcimLoader from '../../lib/billing/helcim-loader';
import type { BalanceTransactionResponse, ListTransactionsResponse } from '@hushbox/shared';

// The em-dash and the en-dash, banned from user-facing copy by docs/DESIGN.md.
const LONG_DASH = /[\u2014\u2013]/;

// api.ts parses VITE_API_URL at import time via frontendEnvSchema; the test
// runtime has no Vite env, so override just that schema while keeping the rest
// of @hushbox/shared (friendlyErrorMessage, TEST_IDS) real.
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    frontendEnvSchema: { parse: () => ({ VITE_API_URL: 'http://localhost:8787' }) },
  };
});

// The amount validator now admits only what the exact-cent converter can price,
// so no field value can reach the pricing step unpriceable. The guard in front
// of that step is a structural boundary, not a copy of the validator, so it is
// proven by suspending the validator for one test rather than by an input the
// field would refuse. The converter stays real: the refusal it raises is real.
const amountGate = vi.hoisted(() => ({ admitAnything: false }));

vi.mock('../../lib/billing/payment-validation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/billing/payment-validation.js')>();
  return {
    ...actual,
    validateAmount: (value: string) =>
      amountGate.admitAnything
        ? { isValid: true, success: 'Valid amount' }
        : actual.validateAmount(value),
  };
});

vi.mock('../../lib/billing/helcim-loader', () => ({
  loadHelcimScript: vi.fn(),
  tokenizeWithHelcim: vi.fn(),
}));

// The rate-limit refusal cases run the REAL `useInitiatePayment`, so its
// transport seam is what they script; every other case keeps the hook mock.
vi.mock('@/lib/api-client.js', () => ({
  client: { billing: { payments: { $post: vi.fn() } } },
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useInitiatePayment: vi.fn(),
  useBalance: vi.fn(),
  useTransactions: vi.fn(),
  billingKeys: {
    all: ['billing'] as const,
    balance: () => ['billing', 'balance'] as const,
    transactions: () => ['billing', 'transactions'] as const,
    transactionList: (cursor?: string) => ['billing', 'transactions', { cursor }] as const,
  },
}));

vi.mock('@/lib/platform/env', () => ({
  env: {
    isDev: true,
    isLocalDev: false,
    isProduction: false,
    isCI: false,
    requiresRealServices: false,
  },
}));

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

// Mutable purchased-wallet balance (NanoUSD string) the useBalance mock reads;
// flip it (and re-render) to simulate the webhook credit landing during
// awaiting-webhook polling. $10 = 10_000_000_000 nano.
const balanceState = { current: '10000000000' };
const mockRefetch = vi.fn();

// The deposit read the useTransactions mock serves: `undefined` is a read that
// has not landed, and a page is the server's newest-first answer.
const depositState: { current: ListTransactionsResponse | undefined } = { current: undefined };

/** A newest-first page of deposits, one per amount (NanoUSD). */
function depositPage(...amountsNanoUsd: string[]): ListTransactionsResponse {
  return {
    transactions: amountsNanoUsd.map(
      (amount, index): BalanceTransactionResponse => ({
        id: `deposit-${String(index)}`,
        amount,
        balanceAfter: amount,
        type: 'deposit',
        paymentId: `payment-${String(index)}`,
        model: null,
        inputCharacters: null,
        outputCharacters: null,
        createdAt: isoAt(TEST_DAY_START),
      })
    ),
    nextCursor: null,
  };
}

/**
 * A failure from the charge route, built the way the transport builds one.
 *
 * The charge carries an `Idempotency-Key`, so `customFetch` marks its response
 * and `ApiError` derives the retry permission from that mark. A fixture that
 * hands over an unmarked response models a request that carried no key — which
 * no charge is — and the mutation then takes the narrow retry arm production
 * never takes.
 */
function chargeFailure(
  status: number,
  body: { code: string; details?: Record<string, unknown> },
  retryAfterMs?: number
): ApiError {
  return new ApiError(body.code, status, body, {
    response: markRequestKeyed(new Response(null, { status }), true),
    retryAfterMs,
  });
}

/**
 * The server's refusal of a deposit made while an earlier one of the same
 * user's is unresolved: the 409 and the registered code it is answered with,
 * which the client reads as a PAIR.
 */
function unresolvedDepositRefusal(): ApiError {
  return chargeFailure(409, { code: ERROR_CODES.PAYMENT_IN_FLIGHT });
}

/** The over-cap refusal the pipeline answers once the counter is spent. */
function overCapRefusal(): ApiError {
  return chargeFailure(
    429,
    { code: ERROR_CODES.RATE_LIMITED, details: { retryAfterSeconds: 30 } },
    30_000
  );
}

/** The refusal the pipeline answers when it cannot reach the counter at all. */
function limiterUnavailableRefusal(): ApiError {
  return chargeFailure(503, { code: ERROR_CODES.RATE_LIMIT_UNAVAILABLE });
}

/**
 * The generic code the Helcim adapter answers to a charge whose outcome it
 * cannot settle — a 503 that proves nothing about whether the handler ran.
 */
function unsettledCharge(): ApiError {
  return chargeFailure(503, { code: ERROR_CODES.UNAVAILABLE });
}

async function fillValidCardDetails(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/card number/i), '4111111111111111');
  await user.type(screen.getByLabelText(/expiry/i), '1230');
  await user.type(screen.getByLabelText(/cvv/i), '123');
  await user.type(screen.getByLabelText(/name on card/i), 'Test User');
  await user.type(screen.getByLabelText(/billing address/i), '123 Test Street');
  await user.type(screen.getByLabelText(/zip/i), '12345');
}

/**
 * Renders the form over the REAL `useInitiatePayment`. Its client carries the
 * app's own mutation retry predicate — `providers/query-provider.tsx` installs
 * this same `shouldRetryMutation` — so an automatic retry happens here exactly
 * where it happens in the app, and a keyed refusal is dispatched as many times
 * here as in production. The charge decision reads what the mutation dispatched,
 * which a mocked `mutateAsync` never produces, so any case that exercises it
 * drives the real mutation and scripts the transport seam (`fetchJson`)
 * underneath instead.
 */
async function renderWithRealCharge(): Promise<void> {
  const realBilling = await vi.importActual<typeof billingHooks>('@/hooks/billing/billing');
  vi.mocked(billingHooks.useInitiatePayment).mockImplementation(realBilling.useInitiatePayment);
  const chargeClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      // The app's `computeRetryDelay` sets the backoff; its duration is
      // immaterial to which card a refusal lands on, so it collapses to none.
      mutations: { retry: shouldRetryMutation, retryDelay: 0 },
    },
  });
  renderWithProviders(
    <QueryClientProvider client={chargeClient}>
      <PaymentForm />
    </QueryClientProvider>
  );
  await flushMicrotasks();
}

/**
 * Every field the payer fills, read off the rendered form. The retry cases
 * compare two readings of this rather than asserting typed-out values, so the
 * formatters that shape what the payer sees stay outside the assertion.
 */
function readPayerFields(): Record<string, string> {
  return {
    amount: screen.getByLabelText<HTMLInputElement>(/amount/i).value,
    cardNumber: screen.getByLabelText<HTMLInputElement>(/card number/i).value,
    expiry: screen.getByLabelText<HTMLInputElement>(/expiry/i).value,
    cvv: screen.getByLabelText<HTMLInputElement>(/cvv/i).value,
    cardHolderName: screen.getByLabelText<HTMLInputElement>(/name on card/i).value,
    billingAddress: screen.getByLabelText<HTMLInputElement>(/billing address/i).value,
    zipCode: screen.getByLabelText<HTMLInputElement>(/zip/i).value,
  };
}

/** Every payer field empty, which is what a cleared form reads as. */
const NO_PAYER_FIELDS: Record<string, string> = {
  amount: '',
  cardNumber: '',
  expiry: '',
  cvv: '',
  cardHolderName: '',
  billingAddress: '',
  zipCode: '',
};

/**
 * Fills a $50 charge with valid card details and submits it, returning what the
 * payer typed as the form rendered it.
 */
async function submitFiftyDollarCharge(): Promise<Record<string, string>> {
  const user = userEvent.setup();
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
  });
  await user.type(screen.getByLabelText(/amount/i), '50');
  await fillValidCardDetails(user);
  const typed = readPayerFields();
  await user.click(screen.getByRole('button', { name: /purchase/i }));
  return typed;
}

/**
 * The variables object the charge's counters are keyed on, read off the first
 * request the mutation authored. TanStack hands `mutationFn` the same reference
 * on every retry, so one reading covers the whole logical mutation.
 */
function chargeVariables(): object {
  const [firstDispatch] = vi.mocked(client.billing.payments.$post).mock.calls;
  if (firstDispatch === undefined) throw new Error('the charge authored no request');
  return firstDispatch[0].json;
}

/**
 * How many requests the charge put on the wire — the counter the form's own
 * proof reads, not a second reading of the same events. The mutation's
 * `failureCount` is neither, because the retry policy moves it while the
 * requests stay the same events.
 */
function chargeDispatchCount(): number {
  return dispatchCountFor(chargeVariables());
}

/** What each of those requests came back with, in dispatch order. */
function chargeDispatchFailures(): readonly unknown[] {
  return dispatchFailuresFor(chargeVariables());
}

// userEvent deadlocks under fake timers (it awaits its own setTimeout), so the
// timeout tests drive the form synchronously via fireEvent + act and flush
// pending microtasks between steps.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setFieldById(id: string, value: string): void {
  const el = document.querySelector(`#${id}`);
  if (!el) throw new Error(`field #${id} not found`);
  fireEvent.change(el, { target: { value } });
}

function submitPaymentForm(): HTMLFormElement {
  const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
  if (!formEl) throw new Error('payment form not found');
  return formEl;
}

function fillValidCardDetailsById(): void {
  setFieldById('amount-input', '50');
  setFieldById('cardNumber', '4111111111111111');
  setFieldById('cardExpiryDate', '12/30');
  setFieldById('cardCVV', '123');
  setFieldById('cardHolderName', 'Test User');
  setFieldById('cardHolderAddress', '123 Test Street');
  setFieldById('cardHolderPostalCode', '12345');
}

describe('PaymentForm', () => {
  const mockInitiatePayment = {
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
    balanceState.current = '10000000000';

    // The token is registry-supplied (VITE_HELCIM_JS_TOKEN) in CiE2E/Production;
    // stub a configured non-dev value so the form renders like a real deploy.
    vi.stubEnv('VITE_HELCIM_JS_TOKEN', 'test-js-token');

    vi.mocked(envModule).env = {
      isDev: true,
      isLocalDev: false,
      isDevServer: false,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    };

    vi.mocked(billingHooks.useInitiatePayment).mockReturnValue(
      mockInitiatePayment as unknown as ReturnType<typeof billingHooks.useInitiatePayment>
    );
    vi.mocked(billingHooks.useBalance).mockImplementation(
      () =>
        ({
          data: makeBalance(balanceState.current),
          refetch: mockRefetch,
        }) as unknown as ReturnType<typeof billingHooks.useBalance>
    );
    depositState.current = undefined;
    // The form reads only `data` off the query; the rest of the query result is
    // not part of what it consumes.
    vi.mocked(billingHooks.useTransactions).mockImplementation(
      () =>
        ({ data: depositState.current }) as unknown as ReturnType<
          typeof billingHooks.useTransactions
        >
    );
    vi.mocked(helcimLoader.loadHelcimScript).mockResolvedValue();
    vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
      success: false,
      errorMessage: 'No card data',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Helcim token configuration', () => {
    it('fails fast when the real tokenizer is used and the token is missing', () => {
      // Real tokenizer runs whenever !isLocalDev (production OR CiE2E). Here the
      // required token is absent, so resolution must throw.
      vi.stubEnv('VITE_HELCIM_JS_TOKEN', '');
      vi.mocked(envModule).env = {
        isDev: false,
        isLocalDev: false,
        isDevServer: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      };
      expect(() => renderWithProviders(<PaymentForm />)).toThrow(/VITE_HELCIM_JS_TOKEN/);
    });

    it('renders and emits an empty token in the mock tokenizer path (local dev)', async () => {
      // Mock tokenizer runs when isLocalDev; it ignores the token, so resolution
      // is empty even when the var happens to be present.
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: false,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };
      expect(() => renderWithProviders(<PaymentForm />)).not.toThrow();
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      const tokenInput = document.querySelector<HTMLInputElement>('#token');
      expect(tokenInput?.value).toBe('');

      await flushMicrotasks();
    });

    it('emits the configured token when the real tokenizer is used (CiE2E / production)', async () => {
      // beforeEach sets isLocalDev:false (the CiE2E state) with a configured
      // token. Token resolution mirrors tokenizer selection, so the real
      // tokenizer must receive the sandbox token — not an empty string.
      renderWithProviders(<PaymentForm />);
      const tokenInput = document.querySelector<HTMLInputElement>('#token');
      expect(tokenInput?.value).toBe('test-js-token');

      await flushMicrotasks();
    });
  });

  describe('single-page layout', () => {
    it('renders amount input on initial render', async () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();

      await flushMicrotasks();
    });

    it('shows minimum $5 in label', async () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByLabelText(/amount.*minimum.*\$5/i)).toBeInTheDocument();

      await flushMicrotasks();
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

    it('renders purchase button', async () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();

      await flushMicrotasks();
    });

    it('renders cancel button when onCancel provided', async () => {
      renderWithProviders(<PaymentForm onCancel={vi.fn()} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();

      await flushMicrotasks();
    });

    it('does not render cancel button when onCancel not provided', async () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();

      await flushMicrotasks();
    });
  });

  describe('the starting amount', () => {
    it('reads the most recent deposit', async () => {
      renderWithProviders(<PaymentForm />);

      expect(billingHooks.useTransactions).toHaveBeenCalledWith({ type: 'deposit', limit: 1 });

      await flushMicrotasks();
    });

    it('starts empty when there is no prior deposit', async () => {
      depositState.current = depositPage();
      renderWithProviders(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');

      await flushMicrotasks();
    });

    it('starts empty while the deposit read has not landed', async () => {
      renderWithProviders(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');

      await flushMicrotasks();
    });

    it('starts at the one prior deposit', async () => {
      depositState.current = depositPage('20000000000');
      renderWithProviders(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('20.00');

      await flushMicrotasks();
    });

    it('starts at the newest of several deposits', async () => {
      depositState.current = depositPage('35500000000', '20000000000', '5000000000');
      renderWithProviders(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('35.50');

      await flushMicrotasks();
    });

    it('shows no validation message for the prefilled amount', async () => {
      depositState.current = depositPage('20000000000');
      renderWithProviders(<PaymentForm />);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByTestId('amount-input-success')).not.toBeInTheDocument();

      await flushMicrotasks();
    });

    it('adopts a deposit read that lands after the form opens', async () => {
      const { rerender } = renderWithProviders(<PaymentForm />);

      depositState.current = depositPage('20000000000');
      rerender(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('20.00');

      await flushMicrotasks();
    });

    it('keeps a typed amount when the deposit read lands later', async () => {
      const user = userEvent.setup();
      const { rerender } = renderWithProviders(<PaymentForm />);

      await user.type(screen.getByLabelText(/amount/i), '50');
      depositState.current = depositPage('20000000000');
      rerender(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('50');
    });

    it('charges the prefilled amount when the payer submits it unchanged', async () => {
      depositState.current = depositPage('20000000000');
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '20000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledWith({
          amountNanoUsd: '20000000000',
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
      });
    });
  });

  describe('the amount after a retry', () => {
    async function declineAndRetry(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole('button', { name: /purchase/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /try again/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
    }

    beforeEach(() => {
      depositState.current = depositPage('20000000000');
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
    });

    it('empties a typed amount when a declined charge is retried', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.clear(screen.getByLabelText(/amount/i));
      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await declineAndRetry(user);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');
    });

    it('empties an untouched prefilled amount when a declined charge is retried', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '20000000000',
      });
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await fillValidCardDetails(user);
      await declineAndRetry(user);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');
    });

    it('empties an untouched prefilled amount when an unconfirmed charge is retried', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await fillValidCardDetails(user);
      await declineAndRetry(user);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');
    });

    it('keeps the amount empty when the deposit read lands again after a retry', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '20000000000',
      });
      const user = userEvent.setup();
      const { rerender } = renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await fillValidCardDetails(user);
      await declineAndRetry(user);
      depositState.current = depositPage('35500000000');
      rerender(<PaymentForm />);

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('');
    });
  });

  describe('what a completed charge reports', () => {
    it('passes the charged amount to onSuccess when the charge returns completed', async () => {
      const onSuccess = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      renderWithProviders(<PaymentForm onSuccess={onSuccess} />);

      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith({ amountNanoUsd: '50000000000' });
      });
    });

    it('passes the charged amount to onSuccess when the webhook credit lands', async () => {
      const onSuccess = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      const { rerender } = renderWithProviders(<PaymentForm onSuccess={onSuccess} />);

      await submitFiftyDollarCharge();
      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalled();
      });
      setFieldById('amount-input', '999');
      balanceState.current = '110000000000';
      rerender(<PaymentForm onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith({ amountNanoUsd: '50000000000' });
      });
    });
  });

  describe('negative-balance disclosure', () => {
    // BILLING §Fee Structure: a top-up clears the deficit before it adds
    // spendable funds, and that is stated at the point of payment rather than
    // discovered from a balance that does not match the amount paid.
    it('states the deficit and the net credit before submit', async () => {
      balanceState.current = '-500000000';
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await user.type(screen.getByLabelText(/amount/i), '5');

      const disclosure = await screen.findByRole('status');
      expect(disclosure).toHaveTextContent('$0.50');
      expect(disclosure).toHaveTextContent('$4.50');
    });

    it('states the deficit alone until the amount covers it', async () => {
      balanceState.current = '-500000000';
      renderWithProviders(<PaymentForm />);

      const disclosure = await screen.findByRole('status');
      expect(disclosure).toHaveTextContent('$0.50');
      expect(disclosure).not.toHaveTextContent('adds');
    });

    it('says nothing when the balance is not negative', async () => {
      balanceState.current = '10000000000';
      renderWithProviders(<PaymentForm />);

      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      await flushMicrotasks();
    });
  });

  describe('amount validation', () => {
    it('shows error when amount is empty on submit', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/please enter an amount/i)).toBeInTheDocument();
      });
    });

    it('shows error when amount is below minimum', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '3');
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/minimum deposit is \$5/i)).toBeInTheDocument();
      });
    });

    it('shows error when amount exceeds maximum', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '1500');
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/maximum deposit is \$1000/i)).toBeInTheDocument();
      });
    });

    it('shows success when amount is valid', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

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

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      const amountInput = screen.getByLabelText(/amount/i);
      await user.type(amountInput, '1e5');

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
    it('sends one charge (amountNanoUsd + token + customerCode) after tokenization', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledWith({
          amountNanoUsd: '50000000000',
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
      });
    });

    it('shows processing button state during payment', async () => {
      const user = userEvent.setup();
      // Tokenization never settles — the form sits in 'processing' after submit.
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockImplementation(() => new Promise(() => {}));
      renderWithProviders(<PaymentForm />);

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

    it('routes a rejected charge to the terminal unconfirmed state', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockRejectedValue(new Error('Charge error'));
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card: that one states the charge did not happen,
      // which a rejected dispatch does not establish.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
    });

    it('states the unconfirmed terminal copy without a long dash', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockRejectedValue(new Error('Charge error'));
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      const body = await screen.findByText(/the credit doesn/i);
      expect(body.textContent).not.toMatch(LONG_DASH);
    });
  });

  describe('cancel functionality', () => {
    it('calls onCancel when cancel button clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('try again functionality', () => {
    it('shows try again button on a server-confirmed failed status', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

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

    // What the retry does to the form is one decision with two answers, and the
    // refusal's code is what picks between them. A declined card is a reason to
    // enter a DIFFERENT one, so that arm clears; a refusal answered before the
    // request reached the charge handler says nothing about the card, so that
    // arm keeps what the payer typed.
    it('clears every typed field when a declined charge is retried', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

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

      await user.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
      expect(readPayerFields()).toEqual(NO_PAYER_FIELDS);
    });

    // Retyping a card number and a CVV — which browsers do not autofill — is
    // what clearing costs a payer refused for a cap a stranger on their carrier
    // address spent. Both codes the pipeline stage can answer take this arm.
    it('leaves every typed field in place when an over-cap refusal is retried', async () => {
      const user = userEvent.setup();
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      vi.mocked(fetchJson).mockRejectedValue(overCapRefusal());

      await renderWithRealCharge();
      const typed = await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
      expect(readPayerFields()).toEqual(typed);
    });

    it('leaves every typed field in place when a limiter-unavailable refusal is retried', async () => {
      const user = userEvent.setup();
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      vi.mocked(fetchJson).mockRejectedValue(limiterUnavailableRefusal());

      await renderWithRealCharge();
      const typed = await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
      expect(readPayerFields()).toEqual(typed);
    });

    // The preserved arm must not outlive the refusal that earned it. The
    // unconfirmed card retries through the same handler, and a code left
    // standing from an earlier refusal would spare a card that outcome says
    // nothing about.
    it('clears the typed fields when a later unconfirmed outcome is retried', async () => {
      const user = userEvent.setup();
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
      vi.mocked(fetchJson).mockRejectedValue(limiterUnavailableRefusal());

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /try again/i }));

      // The second attempt lands on a charge whose outcome nothing settles.
      vi.mocked(fetchJson).mockRejectedValue(unsettledCharge());
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
      expect(readPayerFields()).toEqual(NO_PAYER_FIELDS);
    });
  });

  describe('helcim script loading', () => {
    it('shows loading state while helcim script loads', () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(() => new Promise(() => {}));

      renderWithProviders(<PaymentForm />);

      expect(screen.getByText(/loading.*payment/i)).toBeInTheDocument();
    });

    it('shows the registered load-failure copy when the helcim script fails to load', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue(new Error('Script load failed'));

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_FORM_LOAD_FAILED))
        ).toBeInTheDocument();
      });
    });

    it('never shows the underlying script error to the user', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue(new Error('Script load failed'));

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_FORM_LOAD_FAILED))
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/script load failed/i)).not.toBeInTheDocument();
    });

    it('shows the same load-failure copy when the rejection is not an Error instance', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue('plain string error');

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_FORM_LOAD_FAILED))
        ).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('has accessible form labels', async () => {
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      });
    });

    it('associates error messages with input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

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

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Powered by Helcim')).toBeInTheDocument();
    });

    it('displays helcim branding container', async () => {
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId(TEST_IDS.helcimSecurityBadge)).toBeInTheDocument();
    });
  });

  describe('keyboard navigation', () => {
    it('Enter on amount field focuses card number field', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

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
      vi.mocked(envModule).env = {
        isDev: false,
        isLocalDev: false,
        isDevServer: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.queryByTestId(TEST_IDS.devSimulationButtons)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.simulateSuccessBtn)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.simulateFailureBtn)).not.toBeInTheDocument();
    });

    it('shows simulation buttons in local dev mode', async () => {
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId(TEST_IDS.devSimulationButtons)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.simulateFailureBtn)).toBeInTheDocument();
    });

    it('pre-fills form fields when pre-fill success clicked', async () => {
      const user = userEvent.setup();

      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      const mockSubmit = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = mockSubmit;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));

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
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateFailureBtn)).toBeInTheDocument();
      });

      const mockSubmit = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = mockSubmit;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateFailureBtn));

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
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_FORM_LOAD_FAILED))
        ).toBeInTheDocument();
      });

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

  describe('charge - success path', () => {
    it('shows success view when the charge returns completed', async () => {
      const onSuccess = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });
      expect(screen.getByText('+$50.00')).toBeInTheDocument();
      expect(onSuccess).toHaveBeenCalled();
    });

    it('PaymentSuccessCard close button invokes onCancel', async () => {
      const onCancel = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /close/i }));
      expect(onCancel).toHaveBeenCalled();
    });

    it('PaymentSuccessCard renders without onCancel when omitted', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });

      // Clicking close when no onCancel provided does nothing (no error).
      await user.click(screen.getByRole('button', { name: /close/i }));
    });
  });

  // The amount field carries no `disabled`, so it stays editable for as long as
  // an awaiting-webhook charge polls for its credit. Live form state and the
  // amount the card was charged can therefore diverge before the success card
  // renders, and the card owes the user the figure that was charged.
  describe('post-charge figure', () => {
    async function chargeFiftyAwaitingWebhook(): Promise<ReturnType<typeof renderWithProviders>> {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      const rendered = renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalled();
      });
      return rendered;
    }

    // The webhook credit landing is what flips the poll to success; the amount
    // edited into the field after the charge must not reach the card.
    function landTheCredit(rerender: (ui: React.ReactElement) => void): void {
      balanceState.current = '110000000000';
      rerender(<PaymentForm />);
    }

    it('shows the charged figure when the field is edited after the charge', async () => {
      const { rerender } = await chargeFiftyAwaitingWebhook();

      setFieldById('amount-input', '999');
      landTheCredit(rerender);

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });
      expect(screen.getByText('+$50.00')).toBeInTheDocument();
    });

    // `5e2` is a valid floating-point number, so the number input keeps it even
    // though the amount validator flags it — but it is not a decimal string, and
    // feeding it to the exact-cent helper during render throws on a card that
    // renders only after the user has been charged.
    it('shows the charged figure when the field is edited to an exponent form', async () => {
      const { rerender } = await chargeFiftyAwaitingWebhook();

      setFieldById('amount-input', '5e2');
      landTheCredit(rerender);

      await waitFor(() => {
        expect(screen.getByText('+$50.00')).toBeInTheDocument();
      });
    });
  });

  describe('charge - failed / expired status', () => {
    it('shows error copy when the charge returns failed', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_DECLINED))
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('shows expired copy when the charge returns expired', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'expired',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_EXPIRED))
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('tokenization failures', () => {
    it('shows error view when tokenization returns success: false', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });

    it('leads with our own copy when the processor supplies its own wording', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: false,
        errorMessage: 'ERROR: (token)',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_TOKENIZATION_FAILED))
        ).toBeInTheDocument();
      });
    });

    it('shows the processor wording beneath our copy as supporting detail', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: false,
        errorMessage: 'Insufficient funds',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      const detail = await screen.findByText('Insufficient funds');
      const primary = screen.getByText(
        friendlyErrorMessage(ERROR_CODES.PAYMENT_TOKENIZATION_FAILED)
      );
      expect(primary.compareDocumentPosition(detail)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING as number
      );
    });

    it('renders no supporting detail when the processor said nothing', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({ success: false });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_TOKENIZATION_FAILED))
        ).toBeInTheDocument();
      });
      expect(screen.queryByText('Card tokenization failed')).not.toBeInTheDocument();
    });

    it('drops the processor detail when a later attempt fails without one', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: false,
        errorMessage: 'Insufficient funds',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await screen.findByText('Insufficient funds');

      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({ success: false });
      await user.click(screen.getByRole('button', { name: /try again/i }));

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_TOKENIZATION_FAILED))
        ).toBeInTheDocument();
      });
      expect(screen.queryByText('Insufficient funds')).not.toBeInTheDocument();
    });

    it('shows error when tokenization succeeds but the token is missing', async () => {
      // Success without cardToken — should fall through to "missing token" branch.
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_CARD_DETAILS_MISSING))
        ).toBeInTheDocument();
      });
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('helcim process not available', () => {
    it('shows error when the tokenizer is not installed', async () => {
      const user = userEvent.setup();
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockRejectedValue(
        new Error('Helcim payment processor not available')
      );
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

  describe('awaiting-webhook balance polling', () => {
    it('confirms success when the polled balance rises above the pre-charge baseline', async () => {
      const onSuccess = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      const { rerender } = renderWithProviders(<PaymentForm onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Polling started at baseline $10.00; no success yet.
      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalled();
      });
      expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();

      // The webhook credit lands: balance rises, re-render surfaces it.
      balanceState.current = '110000000000';
      rerender(<PaymentForm onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });
      expect(onSuccess).toHaveBeenCalled();
    });

    it('refetches the balance on an interval while awaiting the webhook', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        mockRefetch.mockClear();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });

        expect(mockRefetch).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('moves to a terminal processing state (never a re-chargeable error) when the credit never lands before the timeout', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        await flushMicrotasks();

        // The approved charge is still settling: a terminal processing card, not
        // an error card. Crucially it never states the payment failed, and its
        // own action starts a further deposit rather than repeating this one.
        expect(screen.getByRole('heading', { name: /payment processing/i })).toBeInTheDocument();
        expect(screen.getByText(/credited shortly/i)).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/timed out/i)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('states the approved-but-unsettled terminal copy without a long dash', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        await flushMicrotasks();

        expect(screen.getByText(/credited shortly/i).textContent).not.toMatch(LONG_DASH);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never issues a second POST /billing/payments after an awaiting_webhook poll timeout', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        // Exactly one charge issued so far.
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        await flushMicrotasks();

        // The deadline itself charges nothing and leaves no form under the card
        // to charge from. A further deposit exists only behind a deliberate
        // click, which is a separate purchase the server rules on.
        expect(screen.getByRole('heading', { name: /payment processing/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /purchase/i })).not.toBeInTheDocument();

        // Clicking the settled-payment actions must never re-POST the charge.
        mockRefetch.mockClear();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: /refresh balance/i }));
          await Promise.resolve();
        });
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: /done/i }));
          await Promise.resolve();
        });
        await flushMicrotasks();

        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
        // "Refresh Balance" only re-reads the balance; it never charges.
        expect(mockRefetch).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the timeout on unmount without a late state update', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        const { unmount } = renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        const errorSpy = vi.spyOn(console, 'error');
        unmount();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(
          errorSpy.mock.calls.some((call) =>
            String(call[0]).includes('state update on an unmounted')
          )
        ).toBe(false);
        errorSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('dev simulate buttons - timer cleanup', () => {
    it('cleans up the simulate timer on unmount without errors', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      const { unmount } = renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));
      unmount();
    });

    it('triggers form requestSubmit ~100ms after simulate-success click', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = requestSubmitSpy;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));

      await waitFor(() => {
        expect(requestSubmitSpy).toHaveBeenCalled();
      });
    });

    it('triggers form requestSubmit ~100ms after simulate-failure click', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateFailureBtn)).toBeInTheDocument();
      });

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = requestSubmitSpy;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateFailureBtn));

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

      resolveLoad();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

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

  describe('PaymentErrorCard with onCancel', () => {
    it('renders both Cancel and Try Again buttons when onCancel provided', async () => {
      const onCancel = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    });
  });

  describe('success card on a form-submitted charge', () => {
    it('renders the success card when a completed charge is submitted through the form element', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '0',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);
      await flushMicrotasks();

      setFieldById('amount-input', '50');
      setFieldById('cardNumber', '4111111111111111');
      setFieldById('cardExpiryDate', '12/30');
      setFieldById('cardCVV', '123');
      setFieldById('cardHolderName', 'Test User');
      setFieldById('cardHolderAddress', '123 Test Street');
      setFieldById('cardHolderPostalCode', '12345');

      await act(async () => {
        fireEvent.submit(submitPaymentForm());
        await Promise.resolve();
      });
      await flushMicrotasks();

      expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
    });
  });

  describe('a second submit arriving while the first is still tokenizing', () => {
    it('dispatches exactly one charge', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      // One deferred tokenizer shared by every call, so both submits are in
      // flight together and both continue when it settles.
      let releaseToken = (): void => {};
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockReturnValue(
        new Promise((resolve) => {
          releaseToken = (): void => {
            resolve({ success: true, cardToken: 'tok_abc', customerCode: 'cust_abc' });
          };
        })
      );

      renderWithProviders(<PaymentForm />);
      await flushMicrotasks();
      fillValidCardDetailsById();

      // Dispatched on the form element rather than the button: the disabled
      // attribute is what a second click would hit, and this is the path that
      // does not — `requestSubmit()` and a second event in one task both reach
      // the handler regardless of what the button renders as.
      const formEl = submitPaymentForm();
      fireEvent.submit(formEl);
      fireEvent.submit(formEl);

      await act(async () => {
        releaseToken();
        await Promise.resolve();
      });
      await flushMicrotasks();

      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('amount already set when simulating', () => {
    it('preserves amount when simulate-success is clicked after typing', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/amount/i), '25');

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) formEl.requestSubmit = requestSubmitSpy;

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('25');
    });
  });

  describe('charge - unknown outcome (thrown exception)', () => {
    // A thrown exception means the POST /billing/payments request was dispatched
    // but its outcome is UNKNOWN (network drop / 5xx) — the processor may have
    // already approved. The failure card would state that charge did not happen,
    // so the UI must land in the state that says what is actually known, and it
    // must dispatch nothing further on its own.
    it('routes a thrown charge to the unknown-outcome state without a second POST', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(new Error('network dropped'));
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // The unknown-outcome card, stating the guard the payer's next move meets
      // rather than the failure the throw did not establish, and with no form
      // under it to charge from.
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(
        screen.getByText(/refused while the first one is still being confirmed/i)
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /purchase/i })).not.toBeInTheDocument();
      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);

      // Re-reading the balance and closing charge nothing — only the retry does,
      // and only when the payer asks for it.
      mockRefetch.mockClear();
      await user.click(screen.getByRole('button', { name: /refresh balance/i }));
      await user.click(screen.getByRole('button', { name: /done/i }));

      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
      expect(mockRefetch).toHaveBeenCalled();
    });

    it('routes a non-Error thrown value to the same unknown-outcome state', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue('some string error');
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card, whose copy states the charge did not happen.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
    });

    // Even a "declined"-looking ApiError is treated conservatively: a thrown
    // response is not a server-confirmed no-charge signal (that arrives inline as
    // a `failed`/`expired` STATUS), so it must not be stated as a failed charge.
    it('routes a thrown ApiError to the unknown-outcome state, never the failure card', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(
        chargeFailure(400, { code: 'PAYMENT_DECLINED' })
      );
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
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
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card, whose copy states the charge did not happen.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
    });
  });

  describe('pre-dispatch pricing failure', () => {
    afterEach(() => {
      amountGate.admitAnything = false;
    });

    // Pricing happens before the single POST /billing/payments, so a refusal
    // there has charged nothing and must be retryable copy, never the
    // unknown-outcome card. The amount validator is suspended for this test so
    // an unpriceable amount reaches the pricing step: what is under test is
    // where the boundary sits, which must hold however the value got there.
    it('routes an amount the converter refuses to the retryable error card', async () => {
      amountGate.admitAnything = true;
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      // An exponent form: a valid floating-point number the number input keeps,
      // and a real `SyntaxError` from the real exact-cent converter.
      fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '5e2' } });
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment failed/i })).toBeInTheDocument();
      });
      expect(screen.getByText(friendlyErrorMessage(ERROR_CODES.VALIDATION))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: /payment unconfirmed/i })
      ).not.toBeInTheDocument();
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });
  });

  // The charge route's two rate-limit layers are both spent at the pipeline
  // edge, which answers its refusal before the handler runs: no `payments`
  // pre-claim, no processor call. The cases below are one decision — a charge
  // every one of whose dispatched requests was refused there is retryable;
  // every other outcome stays unknown. The shared policy never retries a 429,
  // so an over-cap refusal ends the charge on the request that carried it; a
  // keyed 503 is retried, and each of those requests is judged.
  describe('a rate-limit refusal answered before the charge handler ran', () => {
    beforeEach(() => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
    });

    it('routes the limiter refusal to the retryable error card', async () => {
      vi.mocked(fetchJson).mockRejectedValue(overCapRefusal());

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.RATE_LIMITED))
        ).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: /payment unconfirmed/i })
      ).not.toBeInTheDocument();
      // The one request, refused before the handler — which is what the
      // retryable card rests on. A 429 is not retried, so nothing follows it.
      expect(chargeDispatchCount()).toBe(1);
    });

    // A transport failure is retried automatically under the same idempotency
    // key, so the attempt it lost may have reached the handler and been
    // charged. The refusals that end the mutation describe only their own
    // requests; the lost one's outcome is unknown, and the manual retry this
    // card offers would mint a fresh key the server cannot dedup against it.
    it('leaves a limiter refusal that follows a dispatched attempt in the unconfirmed state', async () => {
      vi.mocked(fetchJson)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValue(overCapRefusal());

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
      // Every request is dispatched and judged; the one the transport lost is
      // the one no refusal speaks for.
      expect(chargeDispatchCount()).toBe(2);
    });

    // The generic code is what the Helcim adapter answers to a charge whose
    // outcome it cannot settle, so it proves nothing about whether the handler
    // ran — while `isPipelineRateLimitRefusal` admits the limiter's own
    // fail-closed `RATE_LIMIT_UNAVAILABLE` at this same status. It is the code,
    // not the status, that separates the two 503s.
    it('leaves a 503 carrying the generic UNAVAILABLE code in the unconfirmed state', async () => {
      vi.mocked(fetchJson).mockRejectedValue(unsettledCharge());

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card, whose copy states the charge did not happen.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
    });

    // The third payer-visible outcome: no attempt ever reached a response at
    // all. A transport failure carries no proof about the handler, so each of
    // the requests the policy makes is dispatched and none is accounted for —
    // the comparison the proof rests on is 0 refusals against 3 dispatches,
    // which is the unknown outcome and the only safe one. It is the boundary
    // case for `refused === dispatched`: the two numbers meet at zero
    // dispatches, and the `dispatched > 0` conjunct is what keeps a charge that
    // sent requests from reading as one that sent none.
    it('leaves a charge whose every attempt failed in transport in the unconfirmed state', async () => {
      vi.mocked(fetchJson).mockRejectedValue(new TypeError('Failed to fetch'));

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card, whose copy states the charge did not happen.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
      expect(chargeDispatchCount()).toBe(MAX_RETRIES + 1);
      // Every dispatch recorded a failure, and none of them is an `ApiError` —
      // so none can be a pipeline refusal, which is a status/code pair on one.
      const failures = chargeDispatchFailures();
      expect(failures).toHaveLength(MAX_RETRIES + 1);
      expect(failures.filter((failure) => failure instanceof ApiError)).toHaveLength(0);
    });

    it('routes a limiter-unavailable refusal to the retryable error card', async () => {
      vi.mocked(fetchJson).mockRejectedValue(limiterUnavailableRefusal());

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.RATE_LIMIT_UNAVAILABLE))
        ).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: /payment unconfirmed/i })
      ).not.toBeInTheDocument();
      expect(chargeDispatchCount()).toBe(MAX_RETRIES + 1);
    });

    // The every-dispatch conjunct governs the limiter-unavailable code exactly
    // as it governs the over-cap one: a pre-handler proof speaks for the request
    // that carried it, never for an earlier one already dispatched.
    it('leaves a limiter-unavailable refusal that follows a dispatched attempt in the unconfirmed state', async () => {
      vi.mocked(fetchJson)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValue(limiterUnavailableRefusal());

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
      expect(chargeDispatchCount()).toBe(MAX_RETRIES + 1);
    });

    // The second pair is a PAIR. Admitting the code on any status would be a
    // membership test, and a membership test admits a response the pipeline
    // never wrote.
    it('leaves the limiter-unavailable code at another status in the unconfirmed state', async () => {
      vi.mocked(fetchJson).mockRejectedValue(
        chargeFailure(500, { code: ERROR_CODES.RATE_LIMIT_UNAVAILABLE })
      );

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card, whose copy states the charge did not happen.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
    });

    // The code is half the discriminator: a 429 answered under any other code
    // is not the pipeline refusal, so it earns no safety it has not proven.
    it('leaves a 429 carrying another code in the unconfirmed state', async () => {
      vi.mocked(fetchJson).mockRejectedValue(
        chargeFailure(429, { code: ERROR_CODES.PAYMENT_FAILED })
      );

      await renderWithRealCharge();
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      // Never the failure card, whose copy states the charge did not happen.
      expect(screen.queryByRole('heading', { name: /payment failed/i })).not.toBeInTheDocument();
    });
  });

  // The server refuses a deposit while the same user already has one it has not
  // resolved, and answers 409 with its own code. That refusal is made in the
  // pre-claim transaction, before any processor call, so this attempt charged
  // nothing — but the EARLIER one may already have. The state must therefore
  // say what is true and offer no way to start another purchase, which is the
  // very duplicate the server guard exists to stop.
  describe('a deposit refused because an earlier one is unresolved', () => {
    beforeEach(() => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
    });

    it('renders the refusal with no control that starts another purchase', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(unresolvedDepositRefusal());

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });
      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
        ).toBeInTheDocument();
      });
      // Neither the retryable card's action nor the form beneath it.
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /purchase/i })).not.toBeInTheDocument();
      // Not the unknown-outcome card either: that one tells a payer their card
      // may have been charged, which this refusal proves it was not.
      expect(
        screen.queryByRole('heading', { name: /payment unconfirmed/i })
      ).not.toBeInTheDocument();

      // The only actions re-read the balance or close. Counted as well as named,
      // because the two states that DO offer a further deposit reach it through
      // an action this card must never grow, whatever it is labelled.
      expect(screen.getAllByRole('button')).toHaveLength(2);
      mockRefetch.mockClear();
      await user.click(screen.getByRole('button', { name: /refresh balance/i }));
      await user.click(screen.getByRole('button', { name: /close/i }));
      expect(mockRefetch).toHaveBeenCalled();
      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
    });

    // Single-homed copy (CODE-RULES §Error Responses): the registered message is
    // the only statement of this wording, so the module must hold no copy of it.
    it('carries no copy of the registered wording in the module', () => {
      const source = readFileSync(path.join(import.meta.dirname, 'payment-form.tsx'), 'utf8');
      expect(source).not.toContain(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT));
    });

    // A declined card is a different fact: that charge was attempted and
    // rejected, and re-entering a card is exactly the right next step. The two
    // must not collapse into one state.
    it('leaves a declined charge on the retryable error card', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });
      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_DECLINED))
        ).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(
        screen.queryByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
      ).not.toBeInTheDocument();
    });

    // The status and the code are a PAIR, and each half is pinned on its own.
    // The code read at another status is a response this route never wrote, so
    // it proves nothing about whether the pre-claim refused before charging.
    it('leaves the in-flight code at another status in the unconfirmed state', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(
        chargeFailure(500, { code: ERROR_CODES.PAYMENT_IN_FLIGHT })
      );

      renderWithProviders(<PaymentForm />);
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(
        screen.queryByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
      ).not.toBeInTheDocument();
      // The card's own heading, so a widened predicate is caught by the state it
      // would have rendered and not only by the copy inside it. It replaces an
      // assertion that no retry is offered here: the unknown-outcome state now
      // offers one, and the untruth this test exists to catch was never the
      // retry, it was telling a payer no purchase was started.
      expect(
        screen.queryByRole('heading', { name: /purchase not started/i })
      ).not.toBeInTheDocument();
    });

    // The other half: this route answers a SECOND 409 — an idempotency key
    // reused with a different payment body
    // (`apps/api/src/slices/billing/domain/payments/payments.ts`). That one
    // collides with a claim already made, whose own charge may well have
    // landed, so it establishes nothing about what was charged. Widening the
    // predicate to any 409 would answer it with a card stating no purchase was
    // started — the exact untruth the in-flight state exists to remove.
    it('leaves a 409 carrying another code in the unconfirmed state', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(
        chargeFailure(409, { code: ERROR_CODES.CONFLICT })
      );

      renderWithProviders(<PaymentForm />);
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(
        screen.queryByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: /purchase not started/i })
      ).not.toBeInTheDocument();
    });
  });

  // A charge that was made and has not resolved no longer ends the flow. The
  // server refuses a deposit made while an earlier one of the same user's is
  // unresolved, so a retry from either state is answered by the server: refused
  // while the first is unresolved, admitted as a genuine second deposit once it
  // is not. That authority is the server's, which is why the retry deliberately
  // mints a fresh Idempotency-Key.
  describe('a retry offered by the terminal unresolved-charge states', () => {
    beforeEach(() => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });
    });

    /** Drives a thrown charge, which lands on the unknown-outcome card. */
    async function reachUnconfirmed(): Promise<void> {
      mockInitiatePayment.mutateAsync.mockRejectedValueOnce(new Error('network dropped'));
      renderWithProviders(<PaymentForm />);
      await submitFiftyDollarCharge();
      await screen.findByRole('heading', { name: /payment unconfirmed/i });
    }

    /**
     * Drives an approved charge whose credit never lands, which lands on the
     * approved-but-unsettled card once the poll deadline passes. Fake timers,
     * so the form is driven synchronously (userEvent deadlocks under them).
     */
    async function reachPendingCredit(): Promise<void> {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      renderWithProviders(<PaymentForm />);
      await flushMicrotasks();
      fillValidCardDetailsById();
      await act(async () => {
        fireEvent.submit(submitPaymentForm());
        await Promise.resolve();
      });
      await flushMicrotasks();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await flushMicrotasks();
      expect(screen.getByRole('heading', { name: /payment processing/i })).toBeInTheDocument();
    }

    async function clickAndResubmitSynchronously(retryLabel: RegExp): Promise<void> {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: retryLabel }));
        await Promise.resolve();
      });
      await flushMicrotasks();
      fillValidCardDetailsById();
      await act(async () => {
        fireEvent.submit(submitPaymentForm());
        await Promise.resolve();
      });
      await flushMicrotasks();
    }

    // The retry has to reach the server to be worth anything: the re-entrancy
    // guard that stopped the first attempt from being submitted twice is still
    // held at this point, so a retry that does not release it renders a control
    // that does nothing at all.
    it('dispatches a second charge when the unconfirmed state is retried', async () => {
      await reachUnconfirmed();

      mockInitiatePayment.mutateAsync.mockResolvedValueOnce({
        paymentId: 'pay_456',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /try again/i }));
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(2);
      });
    });

    it('answers a retry from the unconfirmed state with the refusal when the first is unresolved', async () => {
      await reachUnconfirmed();

      mockInitiatePayment.mutateAsync.mockRejectedValueOnce(unresolvedDepositRefusal());
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /try again/i }));
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
        ).toBeInTheDocument();
      });
      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(2);
    });

    it('dispatches a second charge when the pending-credit state is retried', async () => {
      vi.useFakeTimers();
      try {
        await reachPendingCredit();

        await clickAndResubmitSynchronously(/add more credits/i);

        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('answers a retry from the pending-credit state with the refusal when the first is unresolved', async () => {
      vi.useFakeTimers();
      try {
        await reachPendingCredit();

        mockInitiatePayment.mutateAsync.mockRejectedValueOnce(unresolvedDepositRefusal());
        await clickAndResubmitSynchronously(/add more credits/i);

        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT))
        ).toBeInTheDocument();
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    // The declined charge is the state that was always retryable, and it stays
    // exactly as it was: the processor rejected that charge, so re-entering a
    // card is the right next step and the second dispatch is not a duplicate.
    it('dispatches a second charge when a declined charge is retried', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      renderWithProviders(<PaymentForm />);
      await submitFiftyDollarCharge();
      await screen.findByRole('heading', { name: /payment failed/i });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /try again/i }));
      await submitFiftyDollarCharge();

      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('error reason visible in production', () => {
    // beforeEach sets isLocalDev: false, so these run in production mode where
    // DevOnly content is hidden. A PRE-SUBMIT tokenization-trigger failure (the
    // charge is never POSTed, so it is safely retryable) must still surface the
    // real reason on the retryable error card.
    it('shows the reason from a known ApiError code in production', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockRejectedValue(new ApiError('VALIDATION', 400));

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(friendlyErrorMessage('VALIDATION'))).toBeInTheDocument();
      });
      // Never POSTed — the retryable error card is correct here.
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });

    it('shows the generic payment failure for an unplaceable error code', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockRejectedValue(
        new ApiError('SOMETHING_WEIRD', 500)
      );

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage(ERROR_CODES.PAYMENT_FAILED))
        ).toBeInTheDocument();
      });
    });
  });
});

// Every numeric value this form prices, submits or displays is money, so a
// float coercion anywhere in the module is the banned `Number()` on a nano-USD
// amount (CODE-RULES §Money & Settlement) — the source is what the rule is
// about, and it is what is asserted.
describe('payment-form money handling', () => {
  const SOURCE_PATH = path.join(import.meta.dirname, 'payment-form.tsx');
  const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

  // `Number.isNaN` and friends are type guards, not coercions, and are not
  // matched: the ban is on turning a money string into a float.
  const FLOAT_COERCION = /\b(?:Number|parseFloat|parseInt)\s*\(|\.toFixed\s*\(/g;

  function callTargetsIn(functionName: string): string[] {
    const file = ts.createSourceFile(
      SOURCE_PATH,
      SOURCE,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const declaration = file.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
    );
    if (!declaration) {
      throw new Error(`${functionName} is not a top-level function declaration`);
    }
    const targets: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        targets.push(node.expression.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(declaration);
    return targets;
  }

  it('coerces no value through a float', () => {
    expect(SOURCE.match(FLOAT_COERCION)).toBeNull();
  });

  // The success card renders only after the user has been charged, so the
  // dollar-string conversion belongs on the charge path, not in the card: the
  // converter rejects inputs the amount field can still be holding by then, and
  // a throw there lands after the money has moved.
  it('formats the post-charge figure from an already-converted amount', () => {
    const cardCalls = callTargetsIn('PaymentSuccessCard');
    expect(cardCalls).toContain('nanoUsdToDollarString');
    expect(cardCalls).not.toContain('dollarsToNanoUsd');
    expect(callTargetsIn('PaymentForm')).toContain('dollarsToNanoUsd');
  });
});
