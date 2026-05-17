import { useQuery } from '@tanstack/react-query';
import { decryptBinaryWithContentKey, type ContentKey } from '@hushbox/crypto';

interface UseDecryptBlobParams {
  /** Stable cache key. Same id across mount/unmount/remount reuses the decrypted blob URL. */
  contentItemId: string;
  /** Presigned GET URL for the encrypted ciphertext. Null means "not ready yet". */
  downloadUrl: string | null;
  /** Already-unwrapped content key. Null means "not ready yet". */
  contentKey: ContentKey | null;
  /** MIME type used to build the output Blob. */
  mimeType: string;
}

interface DecryptBlobResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/** 30 minutes — bytes are immutable; the cache survives a long scroll-back. */
const BLOB_CACHE_GC_MS = 30 * 60 * 1000;

export const blobCacheKeys = {
  /** All blob-URL cache entries. */
  all: ['media', 'blob'] as const,
  /** One blob URL keyed by contentItemId. */
  blob: (contentItemId: string) => ['media', 'blob', contentItemId] as const,
};

/**
 * Turns (downloadUrl + contentKey + mimeType) into a revocable blob URL,
 * cached in the React Query store keyed by `contentItemId`.
 *
 * Why React Query: blob URLs must survive Virtuoso virtualization. When an
 * off-screen MediaContentItem unmounts, its useState/useEffect-based
 * predecessor revoked the URL and the remount re-fetched from R2 + re-
 * decrypted, churning a fresh blob URL on every scroll cycle (visible as
 * repeated blob:... URLs in the iPhone-15 e2e failure logs). The query
 * cache decouples blob-URL lifetime from component lifetime: the URL is
 * created once, every remount reads the cached value, and revocation is
 * deferred to query GC.
 *
 * Revocation is handled in `installBlobUrlCacheGc` (mounted once at app
 * root). That subscriber listens for query-cache `removed` events on the
 * `['media', 'blob', …]` namespace and calls URL.revokeObjectURL with the
 * evicted value. Keeps revocation out of every consumer's effect cleanup
 * and avoids leaks when a contentItem is finally evicted.
 */
export function useDecryptBlob(params: UseDecryptBlobParams): DecryptBlobResult {
  const { contentItemId, downloadUrl, contentKey, mimeType } = params;
  const enabled = downloadUrl !== null && contentKey !== null;

  const {
    data: blobUrl,
    isLoading: queryLoading,
    error,
  } = useQuery({
    queryKey: blobCacheKeys.blob(contentItemId),
    queryFn: async (): Promise<string> => {
      if (downloadUrl === null || contentKey === null) {
        // `enabled` guards against this — branch exists for type narrowing.
        throw new Error('downloadUrl and contentKey required');
      }
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Media fetch failed: ${String(response.status)}`);
      }
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      const plaintext = decryptBinaryWithContentKey(contentKey, ciphertext);
      const blob = new Blob([plaintext.buffer as ArrayBuffer], { type: mimeType });
      return URL.createObjectURL(blob);
    },
    enabled,
    // Ciphertext bytes never change for a given contentItemId; the blob URL
    // is content-equivalent forever (until the document unloads). No refetch.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_CACHE_GC_MS,
    // Decryption is deterministic; a failure won't succeed on retry.
    retry: false,
  });

  return {
    blobUrl: blobUrl ?? null,
    // `isLoading: true` while either inputs are still resolving or the query
    // is in flight — preserves the pre-React-Query contract so consumers can
    // keep showing a loading placeholder uninterrupted across the
    // awaiting-inputs → decrypting transition.
    isLoading: !enabled || queryLoading,
    error: error ?? null,
  };
}
