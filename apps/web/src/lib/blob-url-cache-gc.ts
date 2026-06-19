import { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Subscribes to the React Query cache and revokes blob URLs when their
 * cache entry is evicted (gcTime expiry, query removal, or app shutdown).
 *
 * The blob-URL lifetime is owned by the query cache, not by individual
 * MediaContentItem components — see `useDecryptBlob`'s docstring. This
 * subscriber is the back half of that contract: once the cache evicts an
 * entry, the underlying object URL would leak without explicit revocation.
 *
 * Idempotent: returns an unsubscribe function so HMR/tests can detach.
 */
export function installBlobUrlCacheGc(queryClient: QueryClient): () => void {
  const cache = queryClient.getQueryCache();
  return cache.subscribe((event) => {
    if (event.type !== 'removed') return;
    // `event.query.queryKey` / `event.query.state.data` come through React
    // Query's generic-erased shape at this callsite, so eslint sees them as
    // `any`. Cast to `unknown` first to force the narrowing through a
    // typeof guard rather than trusting the unwidened type.
    const key = event.query.queryKey as unknown as readonly unknown[];
    if (key[0] !== blobCacheKeys.all[0] || key[1] !== blobCacheKeys.all[1]) return;
    const data = event.query.state.data as unknown;
    if (typeof data === 'string') URL.revokeObjectURL(data);
  });
}
