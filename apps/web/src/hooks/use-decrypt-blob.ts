import { useEffect, useState } from 'react';
import { decryptBinaryWithContentKey } from '@hushbox/crypto';

interface UseDecryptBlobParams {
  /** Presigned GET URL for the encrypted ciphertext. Null means "not ready yet". */
  downloadUrl: string | null;
  /** Already-unwrapped content key. Null means "not ready yet". */
  contentKey: Uint8Array | null;
  /** MIME type used to build the output Blob. */
  mimeType: string;
}

interface DecryptBlobResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Shared primitive that turns (downloadUrl + contentKey + mimeType) into a
 * revocable blob URL. Used by both `useDecryptedMedia` (conversation members,
 * unwraps key from epoch) and `useDecryptedSharedMedia` (share recipients,
 * gets key from shareSecret). Callers compose their specific upstream logic
 * (URL fetch, key unwrap) and feed the results here.
 *
 * Cancellation is checked after the last `await` — everything beyond that
 * point is synchronous, so JS's single-threaded model guarantees the
 * cleanup can't fire mid-statement.
 */
export function useDecryptBlob(params: UseDecryptBlobParams): DecryptBlobResult {
  const { downloadUrl, contentKey, mimeType } = params;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [decrypting, setDecrypting] = useState<boolean>(false);

  useEffect(() => {
    if (!downloadUrl || !contentKey) return;

    let cancelled = false;
    let currentBlobUrl: string | null = null;

    const decrypt = async (): Promise<void> => {
      setDecrypting(true);
      setError(null);
      try {
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`Media fetch failed: ${String(response.status)}`);
        const ciphertext = new Uint8Array(await response.arrayBuffer());

        const plaintext = decryptBinaryWithContentKey(contentKey, ciphertext);
        // This is the last `cancelled` check: everything below is synchronous,
        // so the cleanup can't fire between here and the end of the try block
        // (JS is single-threaded; no `await` boundary to yield on).
        if (cancelled) return;

        const blob = new Blob([plaintext.buffer as ArrayBuffer], { type: mimeType });
        currentBlobUrl = URL.createObjectURL(blob);
        setBlobUrl(currentBlobUrl);
      } catch (error_) {
        if (!cancelled) {
          setError(error_ instanceof Error ? error_ : new Error('Decryption failed'));
        }
      } finally {
        if (!cancelled) setDecrypting(false);
      }
    };

    void decrypt();

    return () => {
      cancelled = true;
      if (currentBlobUrl !== null) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [downloadUrl, contentKey, mimeType]);

  const awaiting = !downloadUrl || !contentKey;
  return {
    blobUrl,
    isLoading: awaiting || decrypting,
    error,
  };
}
