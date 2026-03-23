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

function buildDecryptedMessage(msg: MessageResponse, content: string): Message {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    role: mapSenderTypeToRole(msg.senderType),
    content,
    createdAt: msg.createdAt,
    ...(msg.cost != null && { cost: msg.cost }),
    ...(msg.senderId != null && { senderId: msg.senderId }),
    modelName: msg.modelName,
    parentMessageId: msg.parentMessageId,
  };
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
  messages: MessageResponse[] | undefined,
  privateKeyOverride?: Uint8Array | null
): Message[] {
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const effectivePrivateKey = privateKeyOverride ?? accountPrivateKey;

  const { data: keyChain } = useQuery({
    queryKey: ['keys', conversationId],
    queryFn: async (): Promise<KeyChainResponse> => {
      if (!conversationId) throw new Error('conversationId is required');
      return fetchJson<KeyChainResponse>(
        client.api.keys[':conversationId'].$get({ param: { conversationId } })
      );
    },
    enabled: !!conversationId && !!effectivePrivateKey,
    staleTime: 1000 * 60 * 60, // Key chains rarely change; refetch on epoch rotation
  });

  return useMemo(() => {
    if (
      !conversationId ||
      !messages ||
      messages.length === 0 ||
      !effectivePrivateKey ||
      !keyChain
    ) {
      return [];
    }

    // Populate epoch key cache from key chain.
    // Safe to call in useMemo because epoch-key-cache defers listener
    // notifications via queueMicrotask — no "setState during render" errors.
    processKeyChain(conversationId, keyChain, effectivePrivateKey);

    return messages.map((msg): Message => {
      const epochKey = getEpochKey(conversationId, msg.epochNumber);
      if (!epochKey) {
        return buildDecryptedMessage(msg, '[decryption failed: missing epoch key]');
      }

      try {
        const content = decryptMessage(epochKey, fromBase64(msg.encryptedBlob));
        return buildDecryptedMessage(msg, content);
      } catch {
        return buildDecryptedMessage(msg, '[decryption failed]');
      }
    });
  }, [conversationId, messages, effectivePrivateKey, keyChain]);
}
