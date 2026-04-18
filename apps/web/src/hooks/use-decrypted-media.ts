import { useEffect, useState } from 'react';
import { openMessageEnvelope, decryptBinaryWithContentKey } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { useMediaDownloadUrl } from '@/hooks/use-media-url';

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

/**
 * Fetches a media content item's encrypted bytes, decrypts them client-side
 * using the parent message's wrappedContentKey, and returns a blob URL that
 * can be rendered in an `<img>` tag.
 *
 * The blob URL is revoked when the component unmounts or params change.
 */
export function useDecryptedMedia(params: UseDecryptedMediaParams): DecryptedMediaResult {
  const { contentItemId, conversationId, epochNumber, wrappedContentKey, mimeType } = params;
  const {
    downloadUrl,
    error: urlError,
    isLoading: urlLoading,
  } = useMediaDownloadUrl(contentItemId);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [decrypting, setDecrypting] = useState<boolean>(false);

  useEffect(() => {
    if (!downloadUrl) return;

    let cancelled = false;
    let currentBlobUrl: string | null = null;

    const decrypt = async (): Promise<void> => {
      setDecrypting(true);
      setError(null);
      try {
        const epochKey = getEpochKey(conversationId, epochNumber);
        if (!epochKey) throw new Error('Epoch key not available');

        const contentKey = openMessageEnvelope(epochKey, fromBase64(wrappedContentKey));

        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`Media fetch failed: ${String(response.status)}`);
        const ciphertext = new Uint8Array(await response.arrayBuffer());

        const plaintext = decryptBinaryWithContentKey(contentKey, ciphertext);
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
  }, [downloadUrl, conversationId, epochNumber, wrappedContentKey, mimeType]);

  return {
    blobUrl,
    isLoading: urlLoading || decrypting,
    error: urlError ?? error,
  };
}
