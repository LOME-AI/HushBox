import { useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  getApiUrl,
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
      const response = await api.get<ConversationsResponse>('/conversations');
      return response.conversations;
    },
  });
}

export function useConversation(id: string): ReturnType<typeof useQuery<Conversation, Error>> {
  return useQuery({
    queryKey: chatKeys.conversation(id),
    queryFn: async (): Promise<Conversation> => {
      const response = await api.get<ConversationResponse>(`/conversations/${id}`);
      return response.conversation;
    },
    enabled: !!id,
  });
}

export function useMessages(conversationId: string): ReturnType<typeof useQuery<Message[], Error>> {
  return useQuery({
    queryKey: chatKeys.messages(conversationId),
    queryFn: async (): Promise<Message[]> => {
      const response = await api.get<ConversationResponse>(`/conversations/${conversationId}`);
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
      return api.post<CreateConversationResponse>('/conversations', data);
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
      return api.post<CreateMessageResponse>(`/conversations/${conversationId}/messages`, message);
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
      return api.delete<DeleteConversationResponse>(`/conversations/${conversationId}`);
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
      return api.patch<UpdateConversationResponse>(`/conversations/${conversationId}`, data);
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

interface StreamRequest {
  conversationId: string;
  model: string;
}

interface StreamResult {
  userMessageId: string;
  assistantMessageId: string;
  content: string;
}

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (ids: { userMessageId: string; assistantMessageId: string }) => void;
  signal?: AbortSignal;
}

interface ChatStreamHook {
  isStreaming: boolean;
  startStream: (request: StreamRequest, options?: StreamOptions) => Promise<StreamResult>;
}

export function useChatStream(): ChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);

  const startStream = useCallback(
    async (request: StreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      setIsStreaming(true);

      try {
        const response = await fetch(`${getApiUrl()}/chat/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(request),
          signal: options?.signal ?? null,
        });

        if (!response.ok) {
          const data: unknown = await response.json();
          const errorMessage =
            typeof data === 'object' &&
            data !== null &&
            'error' in data &&
            typeof data.error === 'string'
              ? data.error
              : 'Stream request failed';
          throw new Error(errorMessage);
        }

        // Verify content-type before attempting to parse SSE
        const contentType = response.headers.get('Content-Type');
        if (!contentType?.includes('text/event-stream')) {
          const errorData: unknown = await response.json().catch(() => ({}));
          throw new Error(
            typeof errorData === 'object' &&
              errorData !== null &&
              'error' in errorData &&
              typeof errorData.error === 'string'
              ? errorData.error
              : 'Expected SSE stream but received different content type'
          );
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let userMessageId = '';
        let assistantMessageId = '';
        let content = '';
        let currentEvent = '';

        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard pattern for async iterator
          streamLoop: while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data && currentEvent) {
                  const parsed: unknown = JSON.parse(data);

                  if (currentEvent === 'start') {
                    const startData = parsed as {
                      userMessageId: string;
                      assistantMessageId: string;
                    };
                    userMessageId = startData.userMessageId;
                    assistantMessageId = startData.assistantMessageId;
                    if (options?.onStart) {
                      options.onStart({ userMessageId, assistantMessageId });
                    }
                  } else if (currentEvent === 'token') {
                    const tokenData = parsed as { content: string };
                    content += tokenData.content;
                    if (options?.onToken) {
                      options.onToken(tokenData.content);
                    }
                  } else if (currentEvent === 'error') {
                    const errorData = parsed as { message: string; code?: string };
                    throw new Error(errorData.message);
                  } else if (currentEvent === 'done') {
                    break streamLoop;
                  }
                }
              }
            }
          }

          return { userMessageId, assistantMessageId, content };
        } finally {
          reader.cancel().catch(() => {
            // Reader cleanup errors can be ignored
          });
        }
      } finally {
        setIsStreaming(false);
      }
    },
    []
  );

  return { isStreaming, startStream };
}
