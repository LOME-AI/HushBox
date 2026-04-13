import { useQuery } from '@tanstack/react-query';
import { openShare, decryptTextWithContentKey } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

interface SharedMessageData {
  content: string;
  createdAt: string;
}

interface SharePublicContentItem {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  position: number;
  encryptedBlob: string | null;
  storageKey: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

interface SharePublicResponse {
  shareId: string;
  messageId: string;
  /** Base64-encoded symmetric wrap of the message content key, under a HKDF of shareSecret. */
  wrappedShareKey: string;
  contentItems: SharePublicContentItem[];
  createdAt: string;
}

/**
 * Loads a public shared message under the wrap-once envelope model.
 *
 * 1. GET /api/shares/:shareId → { wrappedShareKey, contentItems, createdAt }
 * 2. Extract shareSecret from the URL fragment (passed as `keyBase64`)
 * 3. openShare(shareSecret, wrappedShareKey) → contentKey (recovers the same
 *    content key conversation members have)
 * 4. For each text content item, decryptTextWithContentKey(contentKey, …)
 * 5. Join text parts by position order into a single `content` string
 *
 * Media items are ignored at Step 1 (text-only). Step 6 will fetch each media
 * item via the presigned download URL and decrypt with the same content key.
 */
export function useSharedMessage(
  shareId: string | null,
  keyBase64: string | null
): ReturnType<typeof useQuery<SharedMessageData>> {
  return useQuery({
    queryKey: ['shared-message', shareId],
    queryFn: async (): Promise<SharedMessageData> => {
      if (!shareId || !keyBase64) {
        throw new Error('Missing share ID or key');
      }

      const response = await fetchJson<SharePublicResponse>(
        client.api.shares[':shareId'].$get({ param: { shareId } })
      );

      const shareSecret = fromBase64(keyBase64);
      const wrappedShareKey = fromBase64(response.wrappedShareKey);
      const contentKey = openShare(shareSecret, wrappedShareKey);

      const textParts: string[] = [];
      for (const item of response.contentItems.toSorted((a, b) => a.position - b.position)) {
        if (item.contentType === 'text' && item.encryptedBlob != null) {
          textParts.push(decryptTextWithContentKey(contentKey, fromBase64(item.encryptedBlob)));
        }
      }

      return { content: textParts.join(''), createdAt: response.createdAt };
    },
    enabled: !!shareId && !!keyBase64,
  });
}
