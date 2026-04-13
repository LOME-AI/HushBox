import { useMutation } from '@tanstack/react-query';
import { openMessageEnvelope, createShare } from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';
import { getEpochKey } from '../lib/epoch-key-cache.js';

interface ShareMessageInput {
  messageId: string;
  conversationId: string;
  epochNumber: number;
  /** Base64-encoded ECIES-wrapped content key from the message row. */
  wrappedContentKey: string;
}

interface ShareMessageResult {
  shareId: string;
  url: string;
}

/**
 * Creates a public share link for a message under the wrap-once envelope model.
 *
 * Unwraps the message's content key with the cached epoch key, re-wraps the
 * content key under a fresh `shareSecret`, and POSTs the tiny wrap to the
 * server. The server never sees the content key or the shareSecret.
 *
 * The request body is ~48 bytes regardless of the message's content size —
 * because only the 32-byte content key is re-wrapped, never the plaintext or
 * any media bytes.
 */
export function useMessageShare(): ReturnType<
  typeof useMutation<ShareMessageResult, Error, ShareMessageInput>
> {
  return useMutation({
    mutationFn: async ({
      messageId,
      conversationId,
      epochNumber,
      wrappedContentKey,
    }: ShareMessageInput): Promise<ShareMessageResult> => {
      const epochKey = getEpochKey(conversationId, epochNumber);
      if (!epochKey) {
        throw new Error(
          `Epoch key not available for conversation ${conversationId} epoch ${String(epochNumber)}`
        );
      }

      const contentKey = openMessageEnvelope(epochKey, fromBase64(wrappedContentKey));
      const { shareSecret, wrappedShareKey } = createShare(contentKey);

      const result = await fetchJson<{ shareId: string }>(
        client.api.messages.share.$post({
          json: { messageId, wrappedShareKey: toBase64(wrappedShareKey) },
        })
      );

      const url = `${globalThis.location.origin}/share/m/${result.shareId}#${toBase64(shareSecret)}`;
      return { shareId: result.shareId, url };
    },
  });
}
