import { createContext, use, useMemo } from 'react';
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

/** Resolves a message's wrapped content key (base64) to its content key. */
export type MessageContentKeySource = (
  conversationId: string,
  epochNumber: number,
  wrappedContentKey: string
) => MessageContentKeyResult;

function unwrapWithCachedEpochKey(
  conversationId: string,
  epochNumber: number,
  wrappedContentKey: string
): MessageContentKeyResult {
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
}

/**
 * Where `useMessageContentKey` gets a message's content key. The default
 * unwraps it with the epoch key from the epoch-key cache; a reader who holds no
 * epoch key provides a source built by `contentKeySourceFor`. The value is a
 * function so a supplied key stays in its closure, out of the context value
 * devtools serialise. A provider memoises it: a new function re-resolves the key.
 */
export const MessageContentKeySourceContext =
  createContext<MessageContentKeySource>(unwrapWithCachedEpochKey);

/**
 * A source that answers with `contentKey` for the message wrapped as
 * `wrappedContentKey`, and with an error for any other wrap.
 */
export function contentKeySourceFor(
  wrappedContentKey: WrappedSecret,
  contentKey: ContentKey
): MessageContentKeySource {
  return (_conversationId, _epochNumber, requestedWrap) => {
    const requested = fromBase64(requestedWrap);
    const isGivenWrap =
      requested.length === wrappedContentKey.length &&
      requested.every((byte, index) => byte === wrappedContentKey[index]);
    if (!isGivenWrap) {
      return {
        contentKey: null,
        wrappedContentKey: null,
        error: new Error('Content key not available'),
      };
    }
    return { contentKey, wrappedContentKey, error: null };
  };
}

/**
 * Resolve a message's content key ONCE per message, through the source
 * `MessageContentKeySourceContext` provides. Hoisted out of `useDecryptedMedia`
 * so an N-media message performs one unwrap, not N. `MessageItem` calls this
 * and stamps the resulting key + wrap onto each media item's
 * `RenderableMedia.envelope`.
 */
export function useMessageContentKey(
  conversationId: string,
  epochNumber: number,
  wrappedContentKey: string
): MessageContentKeyResult {
  const source = use(MessageContentKeySourceContext);
  return useMemo(() => {
    // A message with no media carries no wrapped key, and callers pass '' for
    // it. That is an absent input, not a failure: unwrapping it would reject
    // the zero-length blob and put an `error` on every text-only message.
    if (wrappedContentKey === '') {
      return { contentKey: null, wrappedContentKey: null, error: null };
    }
    try {
      return source(conversationId, epochNumber, wrappedContentKey);
    } catch (error) {
      return {
        contentKey: null,
        wrappedContentKey: null,
        error: error instanceof Error ? error : new Error('Decryption failed'),
      };
    }
  }, [source, conversationId, epochNumber, wrappedContentKey]);
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
   * Presigned GET URL the caller already holds, which a message's media
   * carries when the read that produced it set one, as the public message
   * share's read does. When present, the download-url query
   * (`useMediaDownloadUrl`) stays disabled for this item; when absent, that
   * query mints the URL.
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
  // Skip the network round-trip when the caller already holds a URL, as the
  // public message share's read provides.
  // Passing `null` disables `useMediaDownloadUrl`'s query, whose `enabled` is
  // `!!contentItemId`, for as long as the caller holds a URL.
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
