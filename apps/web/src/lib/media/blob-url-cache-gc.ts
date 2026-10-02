import { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';
import type { QueryClient } from '@tanstack/react-query';

/**
 * React Query erases the cache's generics at this callsite, so a notified
 * query's key arrives as `any`; this is what narrows it before it is read.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

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
    const key: unknown = event.query.queryKey;
    if (!isUnknownArray(key)) return;
    if (key[0] !== blobCacheKeys.all[0] || key[1] !== blobCacheKeys.all[1]) return;
    const data = event.query.state.data as unknown;
    if (typeof data === 'string') URL.revokeObjectURL(data);
  });
}
