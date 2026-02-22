import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  GetBalanceResponse,
  ListTransactionsResponse,
  CreatePaymentResponse,
  ProcessPaymentResponse,
  GetPaymentStatusResponse,
  LedgerEntryType,
} from '@hushbox/shared';
import { useSession } from '@/lib/auth';
import { client, fetchJson } from '../lib/api-client.js';

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
 * Skips the API call for trial (unauthenticated) users.
 */
export function useBalance(): ReturnType<typeof useQuery<GetBalanceResponse, Error>> {
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);

  return useQuery({
    queryKey: billingKeys.balance(),
    queryFn: () => fetchJson<GetBalanceResponse>(client.api.billing.balance.$get()),
    enabled: isAuthenticated,
  });
}

interface TransactionsOptions {
  cursor?: string;
  limit?: number;
  offset?: number;
  type?: LedgerEntryType;
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
      const query: Record<string, string> = {};
      if (cursor) query['cursor'] = cursor;
      if (limit) query['limit'] = String(limit);
      if (offset !== undefined) query['offset'] = String(offset);
      if (type) query['type'] = type;
      return fetchJson<ListTransactionsResponse>(client.api.billing.transactions.$get({ query }));
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
      fetchJson<CreatePaymentResponse>(client.api.billing.payments.$post({ json: { amount } })),
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
      fetchJson<ProcessPaymentResponse>(
        client.api.billing.payments[':id'].process.$post({
          param: { id: paymentId },
          json: { cardToken, customerCode },
        })
      ),
    onSuccess: async (data) => {
      // Invalidate balance when payment is completed
      if (data.status === 'completed') {
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
      return fetchJson<GetPaymentStatusResponse>(
        client.api.billing.payments[':id'].$get({ param: { id: paymentId } })
      );
    },
    enabled: enabled && !!paymentId,
    refetchInterval,
  });
}
