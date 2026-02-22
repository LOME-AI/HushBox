import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deriveKeysFromLinkSecret } from '@hushbox/crypto';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

interface SharedConversationData {
  conversation: { id: string; title: string; currentEpoch: number; titleEpochNumber: number };
  privilege: string;
  wraps: {
    epochNumber: number;
    wrap: string;
    confirmationHash: string;
    privilege: string;
    visibleFromEpoch: number;
  }[];
  chainLinks: { epochNumber: number; chainLink: string; confirmationHash: string }[];
  messages: {
    id: string;
    conversationId: string;
    encryptedBlob: string;
    senderType: string;
    senderId: string | null;
    senderDisplayName: string | null;
    payerId: string | null;
    cost: string | null;
    epochNumber: number;
    sequenceNumber: number;
    createdAt: string;
  }[];
  members: {
    id: string;
    userId: string | null;
    username: string | null;
    privilege: string;
  }[];
  links: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  }[];
}

interface SharedConversationResult {
  data: SharedConversationData | undefined;
  linkPrivateKey: Uint8Array | null;
  isFetching: boolean;
  isLoading: boolean;
  isError: boolean;
  isStale: boolean;
}

export function useSharedConversation(
  conversationId: string | null,
  linkPrivateKeyBase64: string | null
): SharedConversationResult {
  const derivedKeys = useMemo(() => {
    if (!linkPrivateKeyBase64) return null;
    const linkSecret = fromBase64(linkPrivateKeyBase64);
    return deriveKeysFromLinkSecret(linkSecret);
  }, [linkPrivateKeyBase64]);

  const linkPrivateKeyRef = useRef<Uint8Array | null>(null);
  linkPrivateKeyRef.current = derivedKeys?.privateKey ?? null;

  const query = useQuery({
    queryKey: ['shared-conversation', conversationId],
    queryFn: async (): Promise<SharedConversationData> => {
      if (!conversationId || !derivedKeys) throw new Error('Missing conversation ID or key');

      const linkPublicKeyBase64 = toBase64(derivedKeys.publicKey);

      return fetchJson<SharedConversationData>(
        client.api['link-guest'].access.$post({
          json: { conversationId, linkPublicKey: linkPublicKeyBase64 },
        })
      );
    },
    enabled: !!conversationId && !!derivedKeys,
    staleTime: Infinity,
  });

  return {
    data: query.data,
    linkPrivateKey: derivedKeys?.privateKey ?? null,
    isFetching: query.isFetching,
    isLoading: query.isLoading,
    isError: query.isError,
    isStale: query.isStale,
  };
}
