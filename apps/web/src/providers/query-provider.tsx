import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { env } from '@/lib/env';
import { installBlobUrlCacheGc } from '@/lib/blob-url-cache-gc';
import { shouldRetry, shouldRetryMutation, computeRetryDelay } from '@/lib/retry';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes
      retry: shouldRetry,
      retryDelay: computeRetryDelay,
      refetchOnWindowFocus: false,
    },
    // Mutations retry network/no-response failures only (see lib/retry.ts):
    // safe for any mutation, idempotent or not, because the request never got
    // a server response. 5xx is deliberately excluded — the write may have
    // applied, and not every mutation carries an idempotency key.
    mutations: {
      retry: shouldRetryMutation,
      retryDelay: computeRetryDelay,
    },
  },
});

interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: Readonly<QueryProviderProps>): React.JSX.Element {
  // The blob-URL cache (`['media', 'blob', …]`) owns object URLs that survive
  // component unmount via React Query. Without this subscriber, evicted cache
  // entries would leak: the underlying Blob bytes stay reachable until the
  // document unloads. See `useDecryptBlob` for the read side. Lives in an
  // effect so HMR re-installs cleanly without leaking duplicate subscribers.
  React.useEffect(() => installBlobUrlCacheGc(queryClient), []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {env.isLocalDev && !navigator.webdriver && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
