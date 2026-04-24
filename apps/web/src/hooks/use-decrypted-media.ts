import { useMemo } from 'react';
import { openMessageEnvelope } from '@hushbox/crypto';
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
}

interface DecryptedMediaResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

interface UnwrapResult {
  contentKey: Uint8Array | null;
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
      contentKey: openMessageEnvelope(epochKey, fromBase64(wrappedContentKey)),
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
  const { contentItemId, conversationId, epochNumber, wrappedContentKey, mimeType } = params;
  const {
    downloadUrl,
    error: urlError,
    isLoading: urlLoading,
  } = useMediaDownloadUrl(contentItemId);

  const unwrapped = useMemo(
    () => unwrapContentKey(conversationId, epochNumber, wrappedContentKey),
    [conversationId, epochNumber, wrappedContentKey]
  );

  const {
    blobUrl,
    isLoading: decryptLoading,
    error: decryptError,
  } = useDecryptBlob({
    downloadUrl: downloadUrl ?? null,
    contentKey: unwrapped.contentKey,
    mimeType,
  });

  return {
    blobUrl,
    // Hide the "awaiting inputs" loading while we have an unwrap error — the
    // error path should surface immediately, not sit behind a spinner.
    isLoading: urlLoading || (unwrapped.contentKey !== null && decryptLoading),
    error: urlError ?? unwrapped.error ?? decryptError,
  };
}
