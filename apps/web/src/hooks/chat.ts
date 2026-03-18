import { useMemo, useSyncExternalStore } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { decryptMessage } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { useAuthStore } from '../lib/auth';
import { client, fetchJson } from '../lib/api-client';
import {
  getEpochKey,
  processKeyChain,
  subscribe as epochCacheSubscribe,
  getSnapshot as epochCacheSnapshot,
} from '../lib/epoch-key-cache';
import type { KeyChainResponse } from '../lib/epoch-key-cache';
import type {
  Conversation,
  ConversationListItem,
  MessageResponse,
  ConversationsResponse,
  ConversationResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  UpdateConversationRequest,
  UpdateConversationResponse,
  DeleteConversationResponse,
} from '../lib/api';

export const DECRYPTING_TITLE = 'Decrypting...';

export const chatKeys = {
  all: ['chat'] as const,
  conversations: () => [...chatKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...chatKeys.conversations(), id] as const,
};

/** Shared queryFn for GET /conversations/:id. All conversation hooks share this. */
function conversationQueryFn(id: string): () => Promise<ConversationResponse> {
  return async (): Promise<ConversationResponse> => {
    return fetchJson<ConversationResponse>(
      client.api.conversations[':conversationId'].$get({ param: { conversationId: id } })
    );
  };
}

export function useConversations(): ReturnType<typeof useQuery<ConversationListItem[], Error>> {
  const user = useAuthStore((s) => s.user);

  return useQuery({
    queryKey: chatKeys.conversations(),
    queryFn: async (): Promise<ConversationListItem[]> => {
      const response = await fetchJson<ConversationsResponse>(client.api.conversations.$get());
      return response.conversations;
    },
    enabled: !!user,
  });
}

/**
 * Returns conversations with titles eagerly decrypted.
 * Fetches key chains for all conversations in parallel so titles
 * are decrypted immediately — no lazy/deferred decryption.
 */
export function useDecryptedConversations(): {
  data: ConversationListItem[] | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useConversations();
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const cacheVersion = useSyncExternalStore(epochCacheSubscribe, epochCacheSnapshot);

  // Determine which conversations need key chain fetching
  const conversationsNeedingKeys = useMemo(() => {
    if (!data) return [];
    return data.filter((conv) => !getEpochKey(conv.id, conv.titleEpochNumber));
  }, [data, cacheVersion]);

  // Eagerly fetch key chains for all conversations missing epoch keys
  const keyChainResults = useQueries({
    queries: conversationsNeedingKeys.map((conv) => ({
      queryKey: ['keys', conv.id] as const,
      queryFn: async (): Promise<KeyChainResponse> => {
        return fetchJson<KeyChainResponse>(
          client.api.keys[':conversationId'].$get({ param: { conversationId: conv.id } })
        );
      },
      staleTime: 1000 * 60 * 60,
      enabled: !!accountPrivateKey,
    })),
  });

  // Process fetched key chains into epoch key cache
  useMemo(() => {
    if (!accountPrivateKey) return;
    for (const [index, result] of keyChainResults.entries()) {
      const conv = conversationsNeedingKeys[index];
      if (result.data && conv) {
        processKeyChain(conv.id, result.data, accountPrivateKey);
      }
    }
  }, [keyChainResults, accountPrivateKey]);

  // Decrypt titles using cached epoch keys
  const decryptedData = useMemo(() => {
    if (!data) return;
    return data.map((conv): ConversationListItem => {
      const epochKey = getEpochKey(conv.id, conv.titleEpochNumber);
      if (!epochKey || !conv.title) return { ...conv, title: DECRYPTING_TITLE };
      try {
        return { ...conv, title: decryptMessage(epochKey, fromBase64(conv.title)) };
      } catch {
        return { ...conv, title: 'Encrypted conversation' };
      }
    });
  }, [data, cacheVersion]);

  return { data: decryptedData, isLoading };
}

export type ConversationWithCaller = Conversation & {
  callerId: string;
  callerPrivilege: string;
};

export function useConversation(
  id: string
): ReturnType<typeof useQuery<ConversationResponse, Error, ConversationWithCaller>> {
  return useQuery({
    queryKey: chatKeys.conversation(id),
    queryFn: conversationQueryFn(id),
    select: (data): ConversationWithCaller => ({
      ...data.conversation,
      callerId: data.callerId,
      callerPrivilege: data.privilege,
    }),
    enabled: !!id,
  });
}

export function useMessages(
  conversationId: string
): ReturnType<typeof useQuery<ConversationResponse, Error, MessageResponse[]>> {
  return useQuery({
    queryKey: chatKeys.conversation(conversationId),
    queryFn: conversationQueryFn(conversationId),
    select: (data): MessageResponse[] => data.messages,
    enabled: !!conversationId,
  });
}

export function useCreateConversation(): ReturnType<
  typeof useMutation<CreateConversationResponse, Error, CreateConversationRequest>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateConversationRequest): Promise<CreateConversationResponse> => {
      return fetchJson<CreateConversationResponse>(client.api.conversations.$post({ json: data }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

export function useDeleteConversation(): ReturnType<
  typeof useMutation<DeleteConversationResponse, Error, string>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string): Promise<DeleteConversationResponse> => {
      return fetchJson<DeleteConversationResponse>(
        client.api.conversations[':conversationId'].$delete({ param: { conversationId } })
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

export function useUpdateConversation(): ReturnType<
  typeof useMutation<
    UpdateConversationResponse,
    Error,
    { conversationId: string; data: UpdateConversationRequest }
  >
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      data,
    }: {
      conversationId: string;
      data: UpdateConversationRequest;
    }): Promise<UpdateConversationResponse> => {
      return fetchJson<UpdateConversationResponse>(
        client.api.conversations[':conversationId'].$patch({
          param: { conversationId },
          json: data,
        })
      );
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}
