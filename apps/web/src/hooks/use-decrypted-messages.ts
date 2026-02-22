import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { decryptMessage } from '@hushbox/crypto';
import { useAuthStore } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client';
import type { Message } from '@/lib/api';
import { fromBase64 } from '@hushbox/shared';
import type { MessageResponse } from '@hushbox/shared';
import { getEpochKey, processKeyChain } from '@/lib/epoch-key-cache';
import type { KeyChainResponse } from '@/lib/epoch-key-cache';

function mapSenderTypeToRole(senderType: 'user' | 'ai'): 'user' | 'assistant' {
  return senderType === 'ai' ? 'assistant' : 'user';
}

/**
 * Decrypts MessageResponse[] into display Message[] using epoch-based ECIES.
 *
 * 1. Fetches key chain from /api/keys/:conversationId
 * 2. Unwraps epoch keys using account private key (with cache via processKeyChain)
 * 3. Traverses chain links for older epochs
 * 4. Decrypts each message blob with its epoch key
 * 5. Maps senderType to role for display
 */
export function useDecryptedMessages(
  conversationId: string | null,
  messages: MessageResponse[] | undefined
): Message[] {
  const accountPrivateKey = useAuthStore((s) => s.privateKey);

  const { data: keyChain } = useQuery({
    queryKey: ['keys', conversationId],
    queryFn: async (): Promise<KeyChainResponse> => {
      if (!conversationId) throw new Error('conversationId is required');
      return fetchJson<KeyChainResponse>(
        client.api.keys[':conversationId'].$get({ param: { conversationId } })
      );
    },
    enabled: !!conversationId && !!accountPrivateKey,
    staleTime: 1000 * 60 * 60, // Key chains rarely change; refetch on epoch rotation
  });

  return useMemo(() => {
    if (!conversationId || !messages || messages.length === 0 || !accountPrivateKey || !keyChain) {
      return [];
    }

    // Populate epoch key cache from key chain
    processKeyChain(conversationId, keyChain, accountPrivateKey);

    return messages.map((msg): Message => {
      const epochKey = getEpochKey(conversationId, msg.epochNumber);
      if (!epochKey) {
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: mapSenderTypeToRole(msg.senderType),
          content: '[decryption failed: missing epoch key]',
          createdAt: msg.createdAt,
          ...(msg.cost != null && { cost: msg.cost }),
          ...(msg.senderId != null && { senderId: msg.senderId }),
        };
      }

      try {
        const content = decryptMessage(epochKey, fromBase64(msg.encryptedBlob));
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: mapSenderTypeToRole(msg.senderType),
          content,
          createdAt: msg.createdAt,
          ...(msg.cost != null && { cost: msg.cost }),
          ...(msg.senderId != null && { senderId: msg.senderId }),
        };
      } catch {
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: mapSenderTypeToRole(msg.senderType),
          content: '[decryption failed]',
          createdAt: msg.createdAt,
          ...(msg.cost != null && { cost: msg.cost }),
          ...(msg.senderId != null && { senderId: msg.senderId }),
        };
      }
    });
  }, [conversationId, messages, accountPrivateKey, keyChain]);
}
