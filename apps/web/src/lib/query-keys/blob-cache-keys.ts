export const blobCacheKeys = {
  /** All blob-URL cache entries. */
  all: ['media', 'blob'] as const,
  /** One blob URL keyed by contentItemId. */
  blob: (contentItemId: string) => ['media', 'blob', contentItemId] as const,
  /**
   * Ciphertext bytes for a contentItem fetched from a specific presigned URL.
   * The URL is part of the key so a freshly minted (re-signed) URL starts a
   * new fetch rather than reading a cached failure for the stale one (DF7).
   */
  fetch: (contentItemId: string, downloadUrl: string) =>
    ['media', 'fetch', contentItemId, downloadUrl] as const,
};
