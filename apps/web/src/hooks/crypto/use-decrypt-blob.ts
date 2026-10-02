import { useQuery } from '@tanstack/react-query';
import {
  decryptContentEnvelope,
  type ContentKey,
  type ContentLocation,
  type WrappedSecret,
} from '@hushbox/crypto';
import { MAX_MEDIA_OBJECT_BYTES } from '@hushbox/shared';
import { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';

export { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';

/**
 * Location-bound decryptor for media written with the content envelope
 * (`encryptContentEnvelope`). Carries the message's unwrapped content key, the
 * wrapped content key, and this item's full `ContentLocation` tuple — all three
 * feed `decryptContentEnvelope`, whose AAD binds the location and the wrap so a
 * blob relocated to any other item/position/sender fails to decrypt instead of
 * yielding spliced bytes. Every reader uses it: the authenticated chat, the
 * share dialog preview, and the public share page.
 */
export interface MediaEnvelopeDecryptor {
  contentKey: ContentKey;
  wrappedContentKey: WrappedSecret;
  location: ContentLocation;
}

interface UseDecryptBlobParams {
  /** Stable cache key. Same id across mount/unmount/remount reuses the decrypted blob URL. */
  contentItemId: string;
  /** Presigned GET URL for the encrypted ciphertext. Null means "not ready yet". */
  downloadUrl: string | null;
  /**
   * Location-bound envelope decryptor. Absent means "not ready yet" — the
   * caller is still resolving the message content key — and gates fetch and
   * decrypt alike.
   */
  envelope?: MediaEnvelopeDecryptor | undefined;
  /** MIME type used to build the output Blob. */
  mimeType: string;
  /**
   * Content-item plaintext size from item metadata, in bytes. When present and
   * over the server media cap (`MAX_MEDIA_OBJECT_BYTES`), the item is rejected
   * before any fetch or decrypt — a client-side guard that bounds browser
   * memory against an oversized blob independent of trusting the server. Absent
   * when the caller has no size metadata; the guard then does not fire.
   */
  sizeBytes?: number | undefined;
}

interface DecryptBlobResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/** 30 minutes — bytes are immutable; the cache survives a long scroll-back. */
const BLOB_CACHE_GC_MS = 30 * 60 * 1000;

/**
 * Client-side size guard: returns an Error when the item's declared plaintext
 * size exceeds the server media cap (`MAX_MEDIA_OBJECT_BYTES`), else null. The
 * caller rejects an over-cap item before any fetch or decrypt so a hostile or
 * oversized blob can never buffer in browser memory — mirrors the server's
 * write-time cap, no independent magic number. Returns null (no guard) when the
 * caller has no size metadata.
 */
function mediaSizeGuardError(sizeBytes: number | undefined): Error | null {
  if (sizeBytes !== undefined && sizeBytes > MAX_MEDIA_OBJECT_BYTES) {
    return new Error(
      `Media size ${String(sizeBytes)} bytes exceeds client ceiling of ${String(MAX_MEDIA_OBJECT_BYTES)} bytes`
    );
  }
  return null;
}

/**
 * `isLoading: true` while inputs are resolving or either query is in flight —
 * preserves the pre-React-Query contract so consumers keep showing a loading
 * placeholder uninterrupted across awaiting-inputs → fetching → decrypting.
 */
function isBlobLoading(
  fetchEnabled: boolean,
  fetchLoading: boolean,
  decryptEnabled: boolean,
  decryptLoading: boolean
): boolean {
  return !fetchEnabled || fetchLoading || (decryptEnabled && decryptLoading);
}

/**
 * Decrypt fetched ciphertext under the item's location-bound envelope. The
 * throw is unreachable when the caller gates the query on a present envelope;
 * it exists to narrow the type.
 */
function decryptMediaBytes(
  ciphertext: Uint8Array,
  envelope: MediaEnvelopeDecryptor | undefined
): Uint8Array {
  /* v8 ignore next 3 -- unreachable: the decrypt query is gated on a present envelope */
  if (envelope === undefined) {
    throw new Error('an envelope decryptor is required');
  }
  return decryptContentEnvelope(
    envelope.contentKey,
    envelope.wrappedContentKey,
    envelope.location,
    ciphertext
  );
}

/**
 * Bounded retries for the ciphertext fetch. A presigned R2 URL can fail
 * transiently — a just-expired or clock-skewed URL returns 403, a flaky
 * network rejects outright. Without retry such a transient failure was cached
 * for the whole `BLOB_CACHE_GC_MS` window with no recovery (DF7). The decrypt
 * step is deterministic and stays non-retrying.
 */
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 300;

/**
 * Turns (downloadUrl + envelope + mimeType) into a revocable blob URL,
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
  const { contentItemId, downloadUrl, envelope, mimeType, sizeBytes } = params;

  // Reject an over-cap item from its declared metadata before any fetch/decrypt.
  const oversizeError = mediaSizeGuardError(sizeBytes);

  // Gating fetch + decrypt on a ready decryptor preserves the "no network until
  // inputs ready" contract.
  const hasDecryptor = envelope !== undefined;

  // Network fetch — retryable. A transient 403 (expired/skewed presigned URL)
  // or network blip must not be cached as a permanent failure (DF7). Keyed by
  // (contentItemId, downloadUrl) so a re-signed URL starts a fresh fetch.
  // Gated on the decryptor too so no bytes are fetched until the message is
  // decryptable (preserves the "no network until inputs ready" contract).
  const fetchEnabled = downloadUrl !== null && hasDecryptor && oversizeError === null;
  const {
    data: ciphertext,
    isLoading: fetchLoading,
    error: fetchError,
  } = useQuery({
    queryKey:
      downloadUrl === null
        ? ['media', 'fetch', 'noop']
        : blobCacheKeys.fetch(contentItemId, downloadUrl),
    queryFn: async (): Promise<Uint8Array> => {
      /* v8 ignore next 3 -- `enabled: fetchEnabled` gates the queryFn, so downloadUrl is never null here; this throw only narrows the type and is unreachable */
      if (downloadUrl === null) {
        // `enabled` guards against this — branch exists for type narrowing.
        throw new Error('downloadUrl required');
      }
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Media fetch failed: ${String(response.status)}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    enabled: fetchEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_CACHE_GC_MS,
    retry: FETCH_RETRY_COUNT,
    retryDelay: FETCH_RETRY_DELAY_MS,
  });

  // Deterministic decrypt — NOT retryable, and cached under the `blob` key so
  // the resulting URL survives Virtuoso unmount/remount and is revoked by the
  // cache GC (see `installBlobUrlCacheGc`, which keys on `['media','blob',…]`).
  const decryptEnabled = ciphertext !== undefined && hasDecryptor;
  const {
    data: blobUrl,
    isLoading: decryptLoading,
    error: decryptError,
  } = useQuery({
    queryKey: blobCacheKeys.blob(contentItemId),
    queryFn: (): string => {
      /* v8 ignore next 3 -- `enabled: decryptEnabled` requires ciphertext !== undefined, so this throw only narrows the type and is unreachable */
      if (ciphertext === undefined) {
        // `enabled` guards against this — branch exists for type narrowing.
        throw new Error('ciphertext required');
      }
      const plaintext = decryptMediaBytes(ciphertext, envelope);
      // The view, never `.buffer`: decrypted plaintext is a subarray of the
      // codec-framed payload, so the raw buffer carries extra framing bytes.
      // The assertion only discharges `ArrayBufferLike`'s SharedArrayBuffer arm,
      // which crypto never produces; it does not widen what reaches the Blob.
      const blob = new Blob([plaintext as Uint8Array<ArrayBuffer>], { type: mimeType });
      return URL.createObjectURL(blob);
    },
    enabled: decryptEnabled,
    // The blob URL is content-equivalent forever (until the document unloads).
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_CACHE_GC_MS,
    // Decryption is deterministic; a failure won't succeed on retry.
    retry: false,
  });

  // An over-cap item is terminal, not loading — surface its error immediately,
  // with no fetch (gated above) and no blob.
  if (oversizeError !== null) {
    return { blobUrl: null, isLoading: false, error: oversizeError };
  }

  return {
    blobUrl: blobUrl ?? null,
    isLoading: isBlobLoading(fetchEnabled, fetchLoading, decryptEnabled, decryptLoading),
    error: fetchError ?? decryptError ?? null,
  };
}
