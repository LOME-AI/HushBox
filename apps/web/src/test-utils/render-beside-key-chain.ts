import { createElement } from 'react';
import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { keyKeys } from '@/hooks/crypto/keys.js';
import type { StreamChatRotation } from '@hushbox/shared';

/** A rotation payload for a mutation to submit; its keys are placeholders, not key material. */
export const SUBMITTED_ROTATION: StreamChatRotation = {
  expectedEpoch: 1,
  epochPublicKey: 'ep-pub',
  confirmationHash: 'conf-hash',
  chainLink: 'chain',
  encryptedTitle: 'enc-title',
  memberWraps: [{ memberPublicKey: 'mpk', wrap: 'w' }],
};

/**
 * For a test file that mocks `@tanstack/react-query` with spies wrapping the
 * real hooks: drops the canned results earlier suites left on those spies, so
 * the real hooks run again.
 */
export function restoreRealQueryHooks(): void {
  vi.clearAllMocks();
  vi.mocked(useQuery).mockReset();
  vi.mocked(useMutation).mockReset();
  vi.mocked(useQueryClient).mockReset();
}

/**
 * Mounts a mutation hook beside an observer of the conversation's keychain,
 * as the chat page does. The keychain answers epoch 1 on its first fetch; the
 * refetch stays in flight until the returned `landRefetch` is called.
 */
export function renderBesideKeyChain<T>(useMutationHook: () => T): {
  current: () => { mutation: T; keyChain: number | undefined };
  keyChainFetches: () => number;
  landRefetch: (epoch: number) => void;
  queryClient: QueryClient;
} {
  const refetch = Promise.withResolvers<number>();
  const fetchKeyChain = vi
    .fn<() => Promise<number>>()
    .mockResolvedValueOnce(1)
    .mockReturnValueOnce(refetch.promise);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  const { result } = renderHook(
    () => ({
      mutation: useMutationHook(),
      keyChain: useQuery({ queryKey: keyKeys.chain('conv-1'), queryFn: fetchKeyChain }).data,
    }),
    { wrapper: Wrapper }
  );
  return {
    current: () => result.current,
    keyChainFetches: () => fetchKeyChain.mock.calls.length,
    landRefetch: (epoch) => {
      refetch.resolve(epoch);
    },
    queryClient,
  };
}
