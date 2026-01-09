import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';

// Query key factory for billing-related queries
export const billingKeys = {
  all: ['billing'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  transactions: () => [...billingKeys.all, 'transactions'] as const,
  transactionList: (cursor?: string) => [...billingKeys.transactions(), { cursor }] as const,
  payments: () => [...billingKeys.all, 'payments'] as const,
  payment: (id: string) => [...billingKeys.payments(), id] as const,
};

// Response types
interface BalanceResponse {
  balance: string;
}

interface BalanceTransaction {
  id: string;
  amount: string;
  balanceAfter: string;
  type: 'deposit' | 'usage' | 'adjustment';
  description: string;
  paymentId?: string | null;
  createdAt: string;
}

interface TransactionsResponse {
  transactions: BalanceTransaction[];
  nextCursor?: string | null;
}

interface CreatePaymentResponse {
  paymentId: string;
  amount: string;
}

interface ProcessPaymentSuccessResponse {
  status: 'confirmed';
  newBalance: string;
  helcimTransactionId?: string;
}

interface ProcessPaymentProcessingResponse {
  status: 'processing';
  helcimTransactionId: string;
}

type ProcessPaymentResponse = ProcessPaymentSuccessResponse | ProcessPaymentProcessingResponse;

interface PaymentStatusConfirmedResponse {
  status: 'confirmed';
  newBalance: string;
}

interface PaymentStatusFailedResponse {
  status: 'failed';
  errorMessage?: string | null;
}

interface PaymentStatusPendingResponse {
  status: 'pending' | 'awaiting_webhook';
}

type PaymentStatusResponse =
  | PaymentStatusConfirmedResponse
  | PaymentStatusFailedResponse
  | PaymentStatusPendingResponse;

/**
 * Hook to fetch user's current balance.
 */
export function useBalance(): ReturnType<typeof useQuery<BalanceResponse, Error>> {
  return useQuery({
    queryKey: billingKeys.balance(),
    queryFn: () => api.get<BalanceResponse>('billing/balance'),
  });
}

interface TransactionsOptions {
  cursor?: string;
  limit?: number;
  offset?: number;
  type?: 'deposit' | 'usage' | 'adjustment';
  enabled?: boolean;
}

/**
 * Hook to fetch balance transaction history with cursor-based or offset-based pagination.
 */
export function useTransactions(
  options?: TransactionsOptions
): ReturnType<typeof useQuery<TransactionsResponse, Error>> {
  const { cursor, limit = 50, offset, type, enabled = true } = options ?? {};

  return useQuery({
    queryKey: [...billingKeys.transactions(), { cursor, limit, offset, type }] as const,
    queryFn: () => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      if (type) params.set('type', type);

      const url = `billing/transactions${params.toString() ? `?${params.toString()}` : ''}`;
      return api.get<TransactionsResponse>(url);
    },
    enabled,
  });
}

/**
 * Hook to create a new payment record.
 * Returns the payment ID to use for processing.
 */
export function useCreatePayment(): ReturnType<
  typeof useMutation<CreatePaymentResponse, Error, { amount: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ amount }: { amount: string }) =>
      api.post<CreatePaymentResponse>('billing/payments', { amount }),
    onSuccess: () => {
      // Invalidate balance in case it changed
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
    },
  });
}

/**
 * Hook to process a payment with a card token.
 */
export function useProcessPayment(): ReturnType<
  typeof useMutation<ProcessPaymentResponse, Error, { paymentId: string; cardToken: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ paymentId, cardToken }: { paymentId: string; cardToken: string }) =>
      api.post<ProcessPaymentResponse>(`billing/payments/${paymentId}/process`, { cardToken }),
    onSuccess: (data) => {
      // Invalidate balance when payment is confirmed
      if (data.status === 'confirmed') {
        void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        void queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
      }
    },
  });
}

/**
 * Hook to poll payment status.
 * Useful for awaiting webhook confirmation.
 */
export function usePaymentStatus(
  paymentId: string | null,
  options?: { enabled?: boolean; refetchInterval?: number | false }
): ReturnType<typeof useQuery<PaymentStatusResponse, Error>> {
  const { enabled = true, refetchInterval = false } = options ?? {};

  return useQuery({
    queryKey: billingKeys.payment(paymentId ?? ''),
    queryFn: () => {
      if (!paymentId) {
        throw new Error('Payment ID is required');
      }
      return api.get<PaymentStatusResponse>(`billing/payments/${paymentId}`);
    },
    enabled: enabled && !!paymentId,
    refetchInterval,
  });
}

/**
 * Hook to invalidate billing data after external changes.
 */
export function useInvalidateBilling(): () => Promise<void> {
  const queryClient = useQueryClient();

  return async () => {
    await queryClient.invalidateQueries({ queryKey: billingKeys.all });
  };
}
