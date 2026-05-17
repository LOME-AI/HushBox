import type { QueryClient } from '@tanstack/react-query';
import { blobCacheKeys } from '@/hooks/use-decrypt-blob';

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
    const key = event.query.queryKey;
    if (key[0] !== blobCacheKeys.all[0] || key[1] !== blobCacheKeys.all[1]) return;
    const data = event.query.state.data;
    if (typeof data === 'string') URL.revokeObjectURL(data);
  });
}
