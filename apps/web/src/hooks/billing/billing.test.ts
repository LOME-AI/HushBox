import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useBalance,
  useTransactions,
  useCreatePayment,
  useProcessPayment,
  usePaymentStatus,
  billingKeys,
  balanceQueryOptions,
} from '@/hooks/billing/billing.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    api: {
      billing: {
        balance: { $get: vi.fn() },
        transactions: { $get: vi.fn() },
        payments: {
          $post: vi.fn(),
          ':id': {
            $get: vi.fn(),
            process: { $post: vi.fn() },
          },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
  };
});

import { useSession } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';

const mockedUseSession = vi.mocked(useSession);
const mockedUseQuery = vi.mocked(useQuery);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client, true);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the query when user is not authenticated (trial)', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false });
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance());

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: billingKeys.balance(),
        enabled: false,
      })
    );
  });

  it('enables the query when user is authenticated', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' }, session: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance());

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: billingKeys.balance(),
        enabled: true,
      })
    );
  });

  it('disables the query when session is still loading with no user', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: true });
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance());

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });

  it('respects explicit enabled=true override even for unauthenticated users', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false });
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance({ enabled: true }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
      })
    );
  });

  it('respects explicit enabled=false override for authenticated users', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' }, session: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance({ enabled: false }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });
});

describe('balanceQueryOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct queryKey', () => {
    const options = balanceQueryOptions();
    expect(options.queryKey).toEqual(billingKeys.balance());
  });

  it('returns a callable queryFn', () => {
    const options = balanceQueryOptions();
    expect(typeof options.queryFn).toBe('function');
  });

  it('queryFn invokes the balance endpoint via fetchJson', async () => {
    const balanceResponse = { balance: '12.34' };
    const mockResponsePromise = Promise.resolve(new Response());
    vi.mocked(mockedClient.api.billing.balance.$get).mockReturnValue(
      mockResponsePromise as unknown as ReturnType<typeof mockedClient.api.billing.balance.$get>
    );
    mockedFetchJson.mockResolvedValue(balanceResponse);

    const result = await balanceQueryOptions().queryFn();

    expect(mockedClient.api.billing.balance.$get).toHaveBeenCalled();
    expect(mockedFetchJson).toHaveBeenCalledWith(mockResponsePromise);
    expect(result).toBe(balanceResponse);
  });
});

describe('billingKeys', () => {
  it('produces stable key arrays for transactionList with cursor', () => {
    expect(billingKeys.transactionList('cur-1')).toEqual([
      'billing',
      'transactions',
      { cursor: 'cur-1' },
    ]);
  });

  it('produces stable key arrays for transactionList without cursor', () => {
    expect(billingKeys.transactionList()).toEqual([
      'billing',
      'transactions',
      { cursor: undefined },
    ]);
  });

  it('produces stable payment key with id', () => {
    expect(billingKeys.payment('pay-99')).toEqual(['billing', 'payments', 'pay-99']);
  });
});

describe('useTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQuery.mockReset();
    mockedUseQuery.mockImplementation(((options: { queryFn?: () => unknown }) => {
      // call queryFn so the closure executes and we can capture client args
      if (options.queryFn) {
        try {
          options.queryFn();
        } catch {
          /* swallow inside test instrumentation */
        }
      }
      return { data: undefined } as ReturnType<typeof useQuery>;
    }) as unknown as typeof useQuery);
  });

  it('passes default limit (50) when called without options', () => {
    vi.mocked(mockedClient.api.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.api.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions());

    expect(mockedClient.api.billing.transactions.$get).toHaveBeenCalledWith({
      query: { limit: '50' },
    });
  });

  it('forwards cursor, offset, and type into the query', () => {
    vi.mocked(mockedClient.api.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.api.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions({ cursor: 'abc', limit: 10, offset: 20, type: 'deposit' }));

    expect(mockedClient.api.billing.transactions.$get).toHaveBeenCalledWith({
      query: { cursor: 'abc', limit: '10', offset: '20', type: 'deposit' },
    });
  });

  it('omits cursor and offset when not provided', () => {
    vi.mocked(mockedClient.api.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.api.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions({ limit: 25 }));

    expect(mockedClient.api.billing.transactions.$get).toHaveBeenCalledWith({
      query: { limit: '25' },
    });
  });

  it('respects enabled=false', () => {
    renderHook(() => useTransactions({ enabled: false }));

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('defaults enabled to true', () => {
    renderHook(() => useTransactions());

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('omits limit query param when limit is explicitly 0', () => {
    vi.mocked(mockedClient.api.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.api.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions({ limit: 0 }));

    expect(mockedClient.api.billing.transactions.$get).toHaveBeenCalledWith({
      query: {},
    });
  });
});

describe('useCreatePayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQuery.mockImplementation((() => ({
      data: undefined,
    })) as unknown as typeof useQuery);
  });

  it('exposes a mutateAsync that calls the payments endpoint', async () => {
    vi.mocked(mockedClient.api.billing.payments.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.api.billing.payments.$post
      >
    );
    mockedFetchJson.mockResolvedValue({ paymentId: 'pay-1' });

    const { result } = renderHook(() => useCreatePayment(), { wrapper: createWrapper() });

    const response = await result.current.mutateAsync({ amount: '5.00' });

    expect(mockedClient.api.billing.payments.$post).toHaveBeenCalledWith({
      json: { amount: '5.00' },
    });
    expect(response).toEqual({ paymentId: 'pay-1' });
  });

  it('surfaces errors from fetchJson', async () => {
    vi.mocked(mockedClient.api.billing.payments.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.api.billing.payments.$post
      >
    );
    mockedFetchJson.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useCreatePayment(), { wrapper: createWrapper() });

    await expect(result.current.mutateAsync({ amount: '5.00' })).rejects.toThrow('network down');
  });
});

describe('useProcessPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQuery.mockImplementation((() => ({
      data: undefined,
    })) as unknown as typeof useQuery);
  });

  it('invokes the process endpoint with the payment id, token, and customer code', async () => {
    vi.mocked(mockedClient.api.billing.payments[':id'].process.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        (typeof mockedClient.api.billing.payments)[':id']['process']['$post']
      >
    );
    mockedFetchJson.mockResolvedValue({ status: 'processing' });

    const { result } = renderHook(() => useProcessPayment(), { wrapper: createWrapper() });

    await result.current.mutateAsync({
      paymentId: 'pay-1',
      cardToken: 'tok-1',
      customerCode: 'cust-1',
    });

    expect(mockedClient.api.billing.payments[':id'].process.$post).toHaveBeenCalledWith({
      param: { id: 'pay-1' },
      json: { cardToken: 'tok-1', customerCode: 'cust-1' },
    });
  });

  it('invalidates billing balance + transactions when payment is completed', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.mocked(mockedClient.api.billing.payments[':id'].process.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        (typeof mockedClient.api.billing.payments)[':id']['process']['$post']
      >
    );
    mockedFetchJson.mockResolvedValue({ status: 'completed', newBalance: '15.00' });

    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'CustomWrapper';

    const { result } = renderHook(() => useProcessPayment(), { wrapper: Wrapper });

    await result.current.mutateAsync({
      paymentId: 'pay-1',
      cardToken: 'tok-1',
      customerCode: 'cust-1',
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: billingKeys.balance() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: billingKeys.transactions() });
    });
  });

  it('does not invalidate caches when payment status is not completed', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.mocked(mockedClient.api.billing.payments[':id'].process.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        (typeof mockedClient.api.billing.payments)[':id']['process']['$post']
      >
    );
    mockedFetchJson.mockResolvedValue({ status: 'processing' });

    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'CustomWrapper2';

    const { result } = renderHook(() => useProcessPayment(), { wrapper: Wrapper });

    await result.current.mutateAsync({
      paymentId: 'pay-1',
      cardToken: 'tok-1',
      customerCode: 'cust-1',
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('usePaymentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQuery.mockReset();
    mockedUseQuery.mockImplementation(((options: {
      queryFn?: () => unknown;
      enabled?: boolean;
    }) => {
      if (options.queryFn && options.enabled) {
        try {
          options.queryFn();
        } catch {
          /* swallow */
        }
      }
      return { data: undefined } as ReturnType<typeof useQuery>;
    }) as unknown as typeof useQuery);
  });

  it('disables the query when paymentId is null', () => {
    renderHook(() => usePaymentStatus(null));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, refetchInterval: false })
    );
  });

  it('enables the query when paymentId is set', () => {
    renderHook(() => usePaymentStatus('pay-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('respects explicit enabled=false even with paymentId', () => {
    renderHook(() => usePaymentStatus('pay-1', { enabled: false }));

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('forwards refetchInterval option', () => {
    renderHook(() => usePaymentStatus('pay-1', { refetchInterval: 1000 }));

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: 1000 }));
  });

  it('queryFn calls the payment status endpoint with id', () => {
    vi.mocked(mockedClient.api.billing.payments[':id'].$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        (typeof mockedClient.api.billing.payments)[':id']['$get']
      >
    );

    renderHook(() => usePaymentStatus('pay-1'));

    expect(mockedClient.api.billing.payments[':id'].$get).toHaveBeenCalledWith({
      param: { id: 'pay-1' },
    });
  });

  it('queryFn throws when paymentId is null but query is forced enabled', () => {
    let capturedQueryFunction: (() => unknown) | undefined;
    mockedUseQuery.mockReset();
    mockedUseQuery.mockImplementation(((options: { queryFn: () => unknown }) => {
      capturedQueryFunction = options.queryFn;
      return { data: undefined } as ReturnType<typeof useQuery>;
    }) as unknown as typeof useQuery);

    renderHook(() => usePaymentStatus(null, { enabled: true }));

    expect(capturedQueryFunction).toBeDefined();
    expect(() => capturedQueryFunction?.()).toThrow('Payment ID is required');
  });
});
