import { useMemo } from 'react';
import { openMessageEnvelope, type ContentKey, type WrappedContentKey } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { useMediaDownloadUrl } from '@/hooks/use-media-url';
import { useDecryptBlob } from '@/hooks/use-decrypt-blob';

interface UseDecryptedMediaParams {
  contentItemId: string;
  conversationId: string;
  epochNumber: number;
  wrappedContentKey: string;
  mimeType: string;
  /**
   * Pre-fetched presigned GET URL forwarded by the SSE `done` event. When
   * present, we skip the `/api/media/:id/download-url` round-trip — the URL
   * is already on the wire and valid for `MEDIA_DOWNLOAD_URL_TTL_SECONDS`.
   * Falls back to the query when the URL is absent (re-fetched messages) or
   * the in-flight URL has expired.
   */
  preFetchedUrl?: string | undefined;
}

interface DecryptedMediaResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

interface UnwrapResult {
  contentKey: ContentKey | null;
  error: Error | null;
}

/**
 * Pure helper: synchronously look up the epoch key from the cache and unwrap
 * the message's content key. Failure modes (no epoch key, ECIES throw) are
 * returned as an error so the caller can surface them without tripping the
 * decrypt hook's loading state.
 */
function unwrapContentKey(
  conversationId: string,
  epochNumber: number,
  wrappedContentKey: string
): UnwrapResult {
  try {
    const epochKey = getEpochKey(conversationId, epochNumber);
    if (!epochKey) return { contentKey: null, error: new Error('Epoch key not available') };
    return {
      contentKey: openMessageEnvelope(epochKey, fromBase64(wrappedContentKey) as WrappedContentKey),
      error: null,
    };
  } catch (error) {
    return {
      contentKey: null,
      error: error instanceof Error ? error : new Error('Decryption failed'),
    };
  }
}

/**
 * Fetches a media content item's encrypted bytes, decrypts them client-side
 * using the parent message's wrappedContentKey, and returns a blob URL.
 *
 * Composes three pieces:
 *   useMediaDownloadUrl  — fetches the presigned R2 URL
 *   unwrapContentKey     — ECIES-opens the message content key under the epoch
 *   useDecryptBlob       — fetches ciphertext + symmetric decrypt + blob URL
 */
export function useDecryptedMedia(params: UseDecryptedMediaParams): DecryptedMediaResult {
  const { contentItemId, conversationId, epochNumber, wrappedContentKey, mimeType, preFetchedUrl } =
    params;
  // Skip the network round-trip when the SSE done event already gave us a URL.
  // `useMediaDownloadUrl` keys its query on the contentItemId, so passing
  // `null` disables it for the lifetime of this consumer.
  const queryEnabled = preFetchedUrl === undefined;
  const {
    downloadUrl: queriedUrl,
    error: urlError,
    isLoading: urlLoading,
  } = useMediaDownloadUrl(queryEnabled ? contentItemId : null);

  const effectiveUrl = preFetchedUrl ?? queriedUrl;

  const unwrapped = useMemo(
    () => unwrapContentKey(conversationId, epochNumber, wrappedContentKey),
    [conversationId, epochNumber, wrappedContentKey]
  );

  const {
    blobUrl,
    isLoading: decryptLoading,
    error: decryptError,
  } = useDecryptBlob({
    downloadUrl: effectiveUrl ?? null,
    contentKey: unwrapped.contentKey,
    mimeType,
  });

  return {
    blobUrl,
    // Hide the "awaiting inputs" loading while we have an unwrap error — the
    // error path should surface immediately, not sit behind a spinner.
    isLoading: (queryEnabled && urlLoading) || (unwrapped.contentKey !== null && decryptLoading),
    error: urlError ?? unwrapped.error ?? decryptError,
  };
}
