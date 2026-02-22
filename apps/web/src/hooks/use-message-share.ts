import { useMutation } from '@tanstack/react-query';
import { createMessageShare } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

interface ShareMessageInput {
  messageId: string;
  plaintextContent: string;
}

interface ShareMessageResult {
  shareId: string;
  url: string;
}

export function useMessageShare(): ReturnType<
  typeof useMutation<ShareMessageResult, Error, ShareMessageInput>
> {
  return useMutation({
    mutationFn: async ({
      messageId,
      plaintextContent,
    }: ShareMessageInput): Promise<ShareMessageResult> => {
      const { shareSecret, shareBlob } = createMessageShare(plaintextContent);
      const shareBlobBase64 = toBase64(shareBlob);

      const result = await fetchJson<{ shareId: string }>(
        client.api.messages.share.$post({
          json: { messageId, shareBlob: shareBlobBase64 },
        })
      );

      const url = `${globalThis.location.origin}/share/m/${result.shareId}#${toBase64(shareSecret)}`;
      return { shareId: result.shareId, url };
    },
  });
}
