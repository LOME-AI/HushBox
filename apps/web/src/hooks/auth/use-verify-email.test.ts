import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';

const postMock = vi.fn(
  (_args: { json: { token: string } }): Promise<Response> =>
    Promise.resolve(Response.json({ success: true }))
);

// Only the transport is faked: the real `fetchJson` unwraps what it returns.
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    client: {
      auth: {
        'verify-email': { $post: (args: { json: { token: string } }) => postMock(args) },
      },
    },
  };
});

import { useVerifyEmail, verifyEmailKeys } from '@/hooks/auth/use-verify-email';

function createWrapper(
  queryClient: QueryClient
): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

function noop(): void {}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

describe('useVerifyEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the token as the JSON body of the verification request', async () => {
    const { result } = renderHook(() => useVerifyEmail(noop), {
      wrapper: createWrapper(createQueryClient()),
    });

    act(() => {
      result.current.mutate('link-token');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(postMock).toHaveBeenCalledWith({ json: { token: 'link-token' } });
  });

  it('declares the single-use token as what stands in for an idempotency key', async () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useVerifyEmail(noop), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate('link-token');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation?.meta).toEqual({ idempotencyExemption: 'token-is-key' });
  });

  it('files the mutation under the verify-email key', async () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useVerifyEmail(noop), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate('link-token');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const [mutation] = queryClient.getMutationCache().getAll();
    expect(mutation?.options.mutationKey).toEqual(['auth', 'verify-email']);
    expect(verifyEmailKeys.all).toEqual(['auth', 'verify-email']);
  });

  it('calls back once the server confirms the verification', async () => {
    const onVerified = vi.fn();
    const { result } = renderHook(() => useVerifyEmail(onVerified), {
      wrapper: createWrapper(createQueryClient()),
    });

    act(() => {
      result.current.mutate('link-token');
    });

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
  });

  it('does not call back for a refused verification', async () => {
    postMock.mockResolvedValueOnce(
      Response.json({ code: 'INVALID_VERIFICATION_TOKEN' }, { status: 400 })
    );
    const onVerified = vi.fn();
    const { result } = renderHook(() => useVerifyEmail(onVerified), {
      wrapper: createWrapper(createQueryClient()),
    });

    act(() => {
      result.current.mutate('spent-token');
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('fails with the code a refused verification carries', async () => {
    postMock.mockResolvedValueOnce(
      Response.json({ code: 'INVALID_VERIFICATION_TOKEN' }, { status: 400 })
    );
    const { result } = renderHook(() => useVerifyEmail(noop), {
      wrapper: createWrapper(createQueryClient()),
    });

    act(() => {
      result.current.mutate('spent-token');
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.message).toBe('INVALID_VERIFICATION_TOKEN');
  });
});
