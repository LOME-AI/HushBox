import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  GetBalanceResponse,
  ListTransactionsResponse,
  CreatePaymentResponse,
  ProcessPaymentResponse,
  GetPaymentStatusResponse,
  BalanceTransactionType,
} from '@lome-chat/shared';
import { api } from '../lib/api.js';

export const billingKeys = {
  all: ['billing'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  transactions: () => [...billingKeys.all, 'transactions'] as const,
  transactionList: (cursor?: string) => [...billingKeys.transactions(), { cursor }] as const,
  payments: () => [...billingKeys.all, 'payments'] as const,
  payment: (id: string) => [...billingKeys.payments(), id] as const,
};

/**
 * Hook to fetch user's current balance.
 */
export function useBalance(): ReturnType<typeof useQuery<GetBalanceResponse, Error>> {
  return useQuery({
    queryKey: billingKeys.balance(),
    queryFn: () => api.get<GetBalanceResponse>('billing/balance'),
  });
}

interface TransactionsOptions {
  cursor?: string;
  limit?: number;
  offset?: number;
  type?: BalanceTransactionType;
  enabled?: boolean;
}

/**
 * Hook to fetch balance transaction history with cursor-based or offset-based pagination.
 */
export function useTransactions(
  options?: TransactionsOptions
): ReturnType<typeof useQuery<ListTransactionsResponse, Error>> {
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
      return api.get<ListTransactionsResponse>(url);
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
  return useMutation({
    mutationFn: ({ amount }: { amount: string }) =>
      api.post<CreatePaymentResponse>('billing/payments', { amount }),
  });
}

/**
 * Hook to process a payment with a card token.
 * customerCode is required as Helcim links card tokens to customers.
 */
export function useProcessPayment(): ReturnType<
  typeof useMutation<
    ProcessPaymentResponse,
    Error,
    { paymentId: string; cardToken: string; customerCode: string }
  >
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      paymentId,
      cardToken,
      customerCode,
    }: {
      paymentId: string;
      cardToken: string;
      customerCode: string;
    }) =>
      api.post<ProcessPaymentResponse>(`billing/payments/${paymentId}/process`, {
        cardToken,
        customerCode,
      }),
    onSuccess: async (data) => {
      // Invalidate balance when payment is confirmed
      if (data.status === 'confirmed') {
        await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        await queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
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
): ReturnType<typeof useQuery<GetPaymentStatusResponse, Error>> {
  const { enabled = true, refetchInterval = false } = options ?? {};

  return useQuery({
    queryKey: billingKeys.payment(paymentId ?? ''),
    queryFn: () => {
      if (!paymentId) {
        throw new Error('Payment ID is required');
      }
      return api.get<GetPaymentStatusResponse>(`billing/payments/${paymentId}`);
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
