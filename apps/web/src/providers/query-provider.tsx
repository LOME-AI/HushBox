import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ApiError } from '@/lib/api';
import { env } from '@/lib/env';
import { installBlobUrlCacheGc } from '@/lib/blob-url-cache-gc';

/** Skip retries for 4xx client errors (permanent); retry others once. */
export function shouldRetryQuery(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 1;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
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
