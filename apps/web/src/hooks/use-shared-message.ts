import { useQuery } from '@tanstack/react-query';
import { decryptMessageShare } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

interface SharedMessageData {
  content: string;
  createdAt: string;
}

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

      const { shareBlob, createdAt } = await fetchJson<{
        shareId: string;
        messageId: string;
        shareBlob: string;
        createdAt: string;
      }>(client.api.shares[':shareId'].$get({ param: { shareId } }));

      const secret = fromBase64(keyBase64);
      const blobBytes = fromBase64(shareBlob);
      const content = decryptMessageShare(secret, blobBytes);

      return { content, createdAt };
    },
    enabled: !!shareId && !!keyBase64,
  });
}
