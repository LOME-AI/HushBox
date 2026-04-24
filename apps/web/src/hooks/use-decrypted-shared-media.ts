import { useDecryptBlob } from '@/hooks/use-decrypt-blob';

interface UseDecryptedSharedMediaParams {
  /** Presigned GET URL minted server-side for the share response. */
  downloadUrl: string | null;
  /**
   * Already-unwrapped content key for the shared message. The share hook
   * unwraps it once from the `shareSecret` and threads it in per media item.
   * Safe to store in React state for the lifetime of the share view; the
   * view is read-only and ephemeral.
   */
  contentKey: Uint8Array | null;
  /** MIME type used to build the output Blob. */
  mimeType: string;
}

interface DecryptedSharedMediaResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Share-side thin wrapper around `useDecryptBlob`. The share hook unwraps the
 * content key once from the `shareSecret` (not the epoch private key) and the
 * presigned URL is already baked into the share response — so the full
 * fetch+decrypt+blob lifecycle is the only thing left to do.
 */
export function useDecryptedSharedMedia(
  params: UseDecryptedSharedMediaParams
): DecryptedSharedMediaResult {
  return useDecryptBlob(params);
}
