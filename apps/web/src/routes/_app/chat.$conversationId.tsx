import * as React from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { MOCK_MODELS } from '@lome-chat/shared';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import {
  useConversation,
  useMessages,
  useSendMessage,
  useChatStream,
  chatKeys,
} from '@/hooks/chat';
import { useModelStore } from '@/stores/model';
import type { Message } from '@/lib/api';

const searchSchema = z.object({
  triggerStreaming: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/chat/$conversationId')({
  component: ChatConversation,
  validateSearch: searchSchema,
});

function ChatConversation(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const { triggerStreaming } = Route.useSearch();
  const navigate = useNavigate();
  const isNewChat = conversationId === 'new';
  const queryClient = useQueryClient();

  const { selectedModelId, setSelectedModelId } = useModelStore();

  const { data: conversation, isLoading: isConversationLoading } = useConversation(
    isNewChat ? '' : conversationId
  );
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(
    isNewChat ? '' : conversationId
  );

  const sendMessage = useSendMessage();
  const { isStreaming, startStream } = useChatStream();

  const isLoading = isConversationLoading || isMessagesLoading;

  const [inputValue, setInputValue] = React.useState('');
  const [streamingContent, setStreamingContent] = React.useState('');

  // Optimistic messages shown before API confirms
  const [optimisticMessages, setOptimisticMessages] = React.useState<Message[]>([]);

  const allMessages = React.useMemo(() => {
    const messages = apiMessages ?? [];
    // Filter out optimistic messages that now exist in API response
    const apiMessageIds = new Set(messages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    return [...messages, ...pendingOptimistic];
  }, [apiMessages, optimisticMessages]);

  React.useEffect(() => {
    if (apiMessages && apiMessages.length > 0) {
      setOptimisticMessages([]);
    }
  }, [apiMessages]);

  // Handle new chat flow: create conversation → navigate with flag → trigger AI response
  React.useEffect(() => {
    if (!triggerStreaming) {
      return;
    }

    if (isLoading || isStreaming || !apiMessages || apiMessages.length === 0) {
      return;
    }

    const lastMessage = apiMessages[apiMessages.length - 1];

    if (lastMessage?.role === 'user') {
      // Clear the search param to prevent re-triggering on refresh
      void navigate({
        to: '/chat/$conversationId',
        params: { conversationId },
        search: {},
        replace: true,
      });

      setStreamingContent('');
      void startStream(
        { conversationId, model: selectedModelId },
        {
          onToken: (token) => {
            setStreamingContent((prev) => prev + token);
          },
        }
      )
        .then(() => {
          void queryClient.invalidateQueries({
            queryKey: chatKeys.messages(conversationId),
          });
          setStreamingContent('');
        })
        .catch((error: unknown) => {
          console.error('Stream failed:', error);
          setStreamingContent('');
        });
    }
  }, [
    triggerStreaming,
    conversationId,
    apiMessages,
    isLoading,
    isStreaming,
    selectedModelId,
    startStream,
    queryClient,
    navigate,
  ]);

  const handleSend = (): void => {
    const content = inputValue.trim();
    if (!content || isNewChat) {
      return;
    }

    setInputValue('');

    const optimisticMessage: Message = {
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setOptimisticMessages((prev) => [...prev, optimisticMessage]);

    sendMessage.mutate(
      {
        conversationId,
        message: {
          role: 'user',
          content,
        },
      },
      {
        onSuccess: () => {
          // API invalidation will fetch real message
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));

          setStreamingContent('');
          void startStream(
            { conversationId, model: selectedModelId },
            {
              onToken: (token) => {
                setStreamingContent((prev) => prev + token);
              },
            }
          )
            .then(() => {
              void queryClient.invalidateQueries({
                queryKey: chatKeys.messages(conversationId),
              });
              setStreamingContent('');
            })
            .catch((error: unknown) => {
              console.error('Stream failed:', error);
              setStreamingContent('');
            });
        },
        onError: () => {
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
        },
      }
    );
  };

  // Redirect new chat to /chat - should create via NewChatPage
  if (isNewChat) {
    return <Navigate to="/chat" />;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatHeader
          models={MOCK_MODELS}
          selectedModelId={selectedModelId}
          onModelSelect={setSelectedModelId}
        />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-muted-foreground">Loading conversation...</span>
        </div>
      </div>
    );
  }

  if (!conversation) {
    return <Navigate to="/chat" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        models={MOCK_MODELS}
        selectedModelId={selectedModelId}
        onModelSelect={setSelectedModelId}
        title={conversation.title}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {(allMessages.length > 0 || isStreaming) && (
          <MessageList
            messages={allMessages}
            isStreaming={isStreaming}
            streamingContent={streamingContent}
          />
        )}
      </div>
      <div className="border-t p-4">
        <PromptInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSend}
          placeholder="Type a message..."
          maxTokens={2000}
          rows={3}
          disabled={sendMessage.isPending || isStreaming}
        />
      </div>
    </div>
  );
}
