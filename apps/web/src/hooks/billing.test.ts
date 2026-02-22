import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBalance, billingKeys } from './billing.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('../lib/api-client.js', () => ({
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

const mockedUseSession = vi.mocked(useSession);
const mockedUseQuery = vi.mocked(useQuery);

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
});
