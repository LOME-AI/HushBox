import { useMemo } from 'react';
import {
  unwrapContentKeyFromEpoch,
  asEpochPrivateKey,
  type ContentKey,
  type WrappedSecret,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { getEpochKey } from '@/lib/crypto/epoch-key-cache';
import { useMediaDownloadUrl } from '@/hooks/crypto/use-media-url';
import { useDecryptBlob, type MediaEnvelopeDecryptor } from '@/hooks/crypto/use-decrypt-blob';

export type { MediaEnvelopeDecryptor } from '@/hooks/crypto/use-decrypt-blob';

interface MessageContentKeyResult {
  /** Unwrapped content key for the message, or null when unavailable. */
  contentKey: ContentKey | null;
  /**
   * The message's wrapped content key bytes, forwarded so the per-item
   * `decryptContentEnvelope` can bind the same wrap in its AAD. Null iff
   * `contentKey` is null.
   */
  wrappedContentKey: WrappedSecret | null;
  error: Error | null;
}

/**
 * Resolve a message's content key ONCE per message: look up the epoch key from
 * the cache and unwrap the wrapped content key with the new epoch reader
 * (`unwrapContentKeyFromEpoch`, the counterpart of the server's
 * `wrapContentKeyToEpoch`). Hoisted out of `useDecryptedMedia` so an N-media
 * message performs one unwrap, not N. `MessageItem` calls this and stamps the
 * resulting key + wrap onto each media item's `RenderableMedia.envelope`.
 */
export function useMessageContentKey(
  conversationId: string,
  epochNumber: number,
  wrappedContentKey: string
): MessageContentKeyResult {
  return useMemo(() => {
    // A message with no media carries no wrapped key, and callers pass '' for
    // it. That is an absent input, not a failure: unwrapping it would reject
    // the zero-length blob and put an `error` on every text-only message.
    if (wrappedContentKey === '') {
      return { contentKey: null, wrappedContentKey: null, error: null };
    }
    try {
      const epochKey = getEpochKey(conversationId, epochNumber);
      if (!epochKey) {
        return {
          contentKey: null,
          wrappedContentKey: null,
          error: new Error('Epoch key not available'),
        };
      }
      const wrapped = fromBase64(wrappedContentKey) as WrappedSecret;
      const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
      return { contentKey, wrappedContentKey: wrapped, error: null };
    } catch (error) {
      return {
        contentKey: null,
        wrappedContentKey: null,
        error: error instanceof Error ? error : new Error('Decryption failed'),
      };
    }
  }, [conversationId, epochNumber, wrappedContentKey]);
}

interface UseDecryptedMediaParams {
  contentItemId: string;
  /**
   * Location-bound envelope decryptor, built from the message-level content key
   * (resolved once per message, so an N-media message performs one unwrap, not
   * N) plus this item's position. Absent while the parent is still resolving.
   */
  envelope?: MediaEnvelopeDecryptor | undefined;
  mimeType: string;
  /**
   * Pre-fetched presigned GET URL forwarded by the SSE `done` event. When
   * present, we skip the `/api/media/:id/download-url` round-trip — the URL
   * is already on the wire and valid for `MEDIA_DOWNLOAD_URL_TTL_SECONDS`.
   * Falls back to the query when the URL is absent (re-fetched messages) or
   * the in-flight URL has expired.
   */
  preFetchedUrl?: string | undefined;
  /**
   * Content-item plaintext size from item metadata, in bytes. Forwarded to
   * `useDecryptBlob`, which rejects an over-cap item (`MAX_MEDIA_OBJECT_BYTES`)
   * before any fetch or decrypt — the client-side size guard. Absent when the
   * caller has no size metadata; the guard then does not fire.
   */
  sizeBytes?: number | undefined;
}

interface DecryptedMediaResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Compose the hook's public result from the two composed hooks' outputs. Pure
 * and behavior-faithful — hoisted out of `useDecryptedMedia` only to keep it
 * within the cyclomatic-complexity budget; the branch logic here is identical
 * to inlining it.
 */
function composeDecryptedMediaResult(inputs: {
  blobUrl: string | null;
  queryEnabled: boolean;
  urlLoading: boolean;
  hasDecryptor: boolean;
  decryptLoading: boolean;
  urlError: Error | null;
  decryptError: Error | null;
}): DecryptedMediaResult {
  return {
    blobUrl: inputs.blobUrl,
    // Hide "awaiting inputs" loading once the URL has resolved and no decryptor
    // is present — the parent's error path should surface immediately, not sit
    // behind a spinner.
    isLoading:
      (inputs.queryEnabled && inputs.urlLoading) || (inputs.hasDecryptor && inputs.decryptLoading),
    error: inputs.urlError ?? inputs.decryptError,
  };
}

/**
 * Fetches a single media content item's encrypted bytes and decrypts them under
 * the item's location-bound envelope, producing a blob URL.
 *
 * The content key inside that envelope MUST be resolved once at the message
 * level (see `useMessageContentKey`) — an N-media message performs exactly one
 * ECIES unwrap, not N.
 *
 * Composes two pieces:
 *   useMediaDownloadUrl  — fetches the presigned R2 URL
 *   useDecryptBlob       — fetches ciphertext + envelope decrypt + blob URL
 */
export function useDecryptedMedia(params: UseDecryptedMediaParams): DecryptedMediaResult {
  const { contentItemId, envelope, mimeType, preFetchedUrl, sizeBytes } = params;
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

  const {
    blobUrl,
    isLoading: decryptLoading,
    error: decryptError,
  } = useDecryptBlob({
    contentItemId,
    downloadUrl: effectiveUrl ?? null,
    ...(envelope !== undefined && { envelope }),
    mimeType,
    ...(sizeBytes !== undefined && { sizeBytes }),
  });

  const hasDecryptor = envelope !== undefined;

  return composeDecryptedMediaResult({
    blobUrl,
    queryEnabled,
    urlLoading,
    hasDecryptor,
    decryptLoading,
    urlError,
    decryptError,
  });
}
