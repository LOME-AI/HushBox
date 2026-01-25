import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Conversation,
  type Message,
  type ConversationsResponse,
  type ConversationResponse,
  type CreateConversationRequest,
  type CreateConversationResponse,
  type UpdateConversationRequest,
  type UpdateConversationResponse,
  type DeleteConversationResponse,
  type CreateMessageRequest,
  type CreateMessageResponse,
} from '../lib/api';

export const chatKeys = {
  all: ['chat'] as const,
  conversations: () => [...chatKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...chatKeys.conversations(), id] as const,
  messages: (conversationId: string) =>
    [...chatKeys.conversation(conversationId), 'messages'] as const,
};

export function useConversations(): ReturnType<typeof useQuery<Conversation[], Error>> {
  return useQuery({
    queryKey: chatKeys.conversations(),
    queryFn: async (): Promise<Conversation[]> => {
      const response = await api.get<ConversationsResponse>('/api/conversations');
      return response.conversations;
    },
  });
}

export function useConversation(id: string): ReturnType<typeof useQuery<Conversation, Error>> {
  return useQuery({
    queryKey: chatKeys.conversation(id),
    queryFn: async (): Promise<Conversation> => {
      const response = await api.get<ConversationResponse>(`/api/conversations/${id}`);
      return response.conversation;
    },
    enabled: !!id,
  });
}

export function useMessages(conversationId: string): ReturnType<typeof useQuery<Message[], Error>> {
  return useQuery({
    queryKey: chatKeys.messages(conversationId),
    queryFn: async (): Promise<Message[]> => {
      const response = await api.get<ConversationResponse>(`/api/conversations/${conversationId}`);
      return response.messages;
    },
    enabled: !!conversationId,
  });
}

export function useCreateConversation(): ReturnType<
  typeof useMutation<CreateConversationResponse, Error, CreateConversationRequest>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateConversationRequest): Promise<CreateConversationResponse> => {
      return api.post<CreateConversationResponse>('/api/conversations', data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

export function useSendMessage(): ReturnType<
  typeof useMutation<
    CreateMessageResponse,
    Error,
    { conversationId: string; message: CreateMessageRequest }
  >
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      message,
    }: {
      conversationId: string;
      message: CreateMessageRequest;
    }): Promise<CreateMessageResponse> => {
      return api.post<CreateMessageResponse>(
        `/api/conversations/${conversationId}/messages`,
        message
      );
    },
    onSuccess: (data, variables) => {
      queryClient.setQueryData(
        chatKeys.messages(variables.conversationId),
        (old: Message[] | undefined) => [...(old ?? []), data.message]
      );
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
      return api.delete<DeleteConversationResponse>(`/api/conversations/${conversationId}`);
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
      return api.patch<UpdateConversationResponse>(`/api/conversations/${conversationId}`, data);
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}
