import * as React from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import {
  useConversation,
  useMessages,
  useSendMessage,
  useChatStream,
  chatKeys,
} from '@/hooks/chat';
import { billingKeys, useBalance } from '@/hooks/billing';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useInteractionTracker } from '@/hooks/use-interaction-tracker';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';

const searchSchema = z.object({
  triggerStreaming: z.boolean().optional(),
});

export const Route = createFileRoute('/_app/chat/$conversationId')({
  component: ChatConversationWithErrorBoundary,
  validateSearch: searchSchema,
});

function ChatConversationWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ChatConversation />
    </ErrorBoundary>
  );
}

function ChatConversation(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const { triggerStreaming } = Route.useSearch();
  const navigate = useNavigate();
  const isNewChat = conversationId === 'new';
  const queryClient = useQueryClient();
  const viewportHeight = useVisualViewportHeight();

  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const { data: balanceData } = useBalance();
  const balance = parseFloat(balanceData?.balance ?? '0');
  const canAccessPremium = isAuthenticated && balance > 0;

  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();

  const { data: modelsData } = useModels();
  const models = React.useMemo(() => modelsData?.models ?? [], [modelsData?.models]);
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();

  const {
    signupModalOpen,
    paymentModalOpen,
    premiumModelName,
    setSignupModalOpen,
    setPaymentModalOpen,
  } = useUIModalsStore();

  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

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

  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null);

  const [optimisticMessages, setOptimisticMessages] = React.useState<Message[]>([]);

  const [documentsByMessage, setDocumentsByMessage] = React.useState<Record<string, Document[]>>(
    {}
  );

  const handleDocumentsExtracted = React.useCallback((messageId: string, docs: Document[]) => {
    setDocumentsByMessage((prev) => ({
      ...prev,
      [messageId]: docs,
    }));
  }, []);

  const allDocuments = React.useMemo(() => {
    return Object.values(documentsByMessage).flat();
  }, [documentsByMessage]);

  const allMessages = React.useMemo(() => {
    const messages = apiMessages ?? [];
    const apiMessageIds = new Set(messages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    return [...messages, ...pendingOptimistic];
  }, [apiMessages, optimisticMessages]);

  const historyCharacters = React.useMemo(() => {
    return allMessages.reduce((total, message) => {
      return total + message.content.length;
    }, 0);
  }, [allMessages]);

  const streamingMessageIdRef = React.useRef<string | null>(null);

  const viewportRef = React.useRef<HTMLDivElement>(null);
  const promptInputRef = React.useRef<PromptInputRef>(null);

  const { handleScroll, scrollToBottom, isAutoScrollEnabledRef } = useAutoScroll({
    isStreaming,
    viewportRef,
  });

  const { hasInteractedRef, resetOnSubmit } = useInteractionTracker({
    isTracking: isStreaming,
  });

  const shouldFocusAfterStreamingRef = React.useRef(false);

  const wasStreamingRef = React.useRef(false);

  React.useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      const shouldFocus = shouldFocusAfterStreamingRef.current && !hasInteractedRef.current;

      if (shouldFocus) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            promptInputRef.current?.focus();
          });
        });
      }
      shouldFocusAfterStreamingRef.current = false;
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, hasInteractedRef]);

  // Focus input when arriving on a newly-created conversation
  // (streaming completed in chat.new, we're arriving with cached data)
  const hasInitialFocusedRef = React.useRef(false);

  React.useEffect(() => {
    if (hasInitialFocusedRef.current) return;

    // If not loading, not streaming, and we have messages, focus the input
    // This handles arrival from /chat/new where streaming already completed
    if (!isLoading && !isStreaming && allMessages.length > 0) {
      hasInitialFocusedRef.current = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          promptInputRef.current?.focus();
        });
      });
    }
  }, [isLoading, isStreaming, allMessages.length]);

  React.useEffect(() => {
    if (!triggerStreaming) {
      return;
    }

    if (isLoading || isStreaming || !apiMessages || apiMessages.length === 0) {
      return;
    }

    const lastMessage = apiMessages[apiMessages.length - 1];

    if (lastMessage?.role === 'user') {
      void navigate({
        to: '/chat/$conversationId',
        params: { conversationId },
        search: {},
        replace: true,
      });

      shouldFocusAfterStreamingRef.current = true;

      void startStream(
        { conversationId, model: selectedModelId },
        {
          onStart: ({ assistantMessageId }) => {
            const assistantMessage: Message = {
              id: assistantMessageId,
              conversationId,
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            };
            setOptimisticMessages((prev) => [...prev, assistantMessage]);
            setStreamingMessageId(assistantMessageId);
            streamingMessageIdRef.current = assistantMessageId;
          },
          onToken: (token) => {
            const msgId = streamingMessageIdRef.current;
            if (msgId) {
              setOptimisticMessages((prev) =>
                prev.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
              );
            }
            if (isAutoScrollEnabledRef.current) {
              scrollToBottom();
            }
          },
        }
      )
        .then(async ({ assistantMessageId }) => {
          setStreamingMessageId(null);
          streamingMessageIdRef.current = null;

          await new Promise((resolve) => setTimeout(resolve, 500));

          await queryClient.invalidateQueries({ queryKey: chatKeys.messages(conversationId) });
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          setOptimisticMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
        })
        .catch((error: unknown) => {
          console.error('Stream failed:', error);
          setStreamingMessageId(null);
          streamingMessageIdRef.current = null;
          shouldFocusAfterStreamingRef.current = false;
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isAutoScrollEnabledRef is a stable ref
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
    scrollToBottom,
  ]);

  const handleSend = (): void => {
    const content = inputValue.trim();
    if (!content || isNewChat) {
      return;
    }

    setInputValue('');

    resetOnSubmit();
    shouldFocusAfterStreamingRef.current = true;

    const optimisticUserMessage: Message = {
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setOptimisticMessages((prev) => [...prev, optimisticUserMessage]);

    scrollToBottom();

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
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticUserMessage.id));

          void startStream(
            { conversationId, model: selectedModelId },
            {
              onStart: ({ assistantMessageId }) => {
                const assistantMessage: Message = {
                  id: assistantMessageId,
                  conversationId,
                  role: 'assistant',
                  content: '',
                  createdAt: new Date().toISOString(),
                };
                setOptimisticMessages((prev) => [...prev, assistantMessage]);
                setStreamingMessageId(assistantMessageId);
                streamingMessageIdRef.current = assistantMessageId;
              },
              onToken: (token) => {
                const msgId = streamingMessageIdRef.current;
                if (msgId) {
                  setOptimisticMessages((prev) =>
                    prev.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
                  );
                }
                if (isAutoScrollEnabledRef.current) {
                  scrollToBottom();
                }
              },
            }
          )
            .then(async ({ assistantMessageId }) => {
              setStreamingMessageId(null);
              streamingMessageIdRef.current = null;

              await new Promise((resolve) => setTimeout(resolve, 500));

              await queryClient.invalidateQueries({ queryKey: chatKeys.messages(conversationId) });
              void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

              setOptimisticMessages((prev) => prev.filter((m) => m.id !== assistantMessageId));
            })
            .catch((error: unknown) => {
              console.error('Stream failed:', error);
              setStreamingMessageId(null);
              streamingMessageIdRef.current = null;
              shouldFocusAfterStreamingRef.current = false;
            });
        },
        onError: () => {
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticUserMessage.id));
          shouldFocusAfterStreamingRef.current = false;
          promptInputRef.current?.focus();
        },
      }
    );
  };

  if (isNewChat) {
    return <Navigate to="/chat" />;
  }

  if (isLoading) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        style={{ height: `${String(viewportHeight)}px` }}
      >
        <ChatHeader
          models={models}
          selectedModelId={selectedModelId}
          selectedModelName={selectedModelName}
          onModelSelect={setSelectedModel}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          onPremiumClick={handlePremiumClick}
        />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-muted-foreground">Loading conversation...</span>
        </div>
        <SignupModal
          open={signupModalOpen}
          onOpenChange={setSignupModalOpen}
          modelName={premiumModelName}
        />
        <PaymentModal
          open={paymentModalOpen}
          onOpenChange={setPaymentModalOpen}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }}
        />
      </div>
    );
  }

  if (!conversation) {
    return <Navigate to="/chat" />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ height: `${String(viewportHeight)}px` }}
    >
      <ChatHeader
        models={models}
        selectedModelId={selectedModelId}
        selectedModelName={selectedModelName}
        onModelSelect={setSelectedModel}
        title={conversation.title}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        onPremiumClick={handlePremiumClick}
      />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          {allMessages.length > 0 && (
            <MessageList
              messages={allMessages}
              streamingMessageId={streamingMessageId}
              onDocumentsExtracted={handleDocumentsExtracted}
              viewportRef={viewportRef}
              onScroll={handleScroll}
            />
          )}
        </div>
        <DocumentPanel documents={allDocuments} />
      </div>
      <div className="flex-shrink-0 border-t p-4">
        <PromptInput
          ref={promptInputRef}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSend}
          placeholder="Type a message..."
          historyCharacters={historyCharacters}
          rows={2}
          minHeight="56px"
          maxHeight="112px"
          disabled={sendMessage.isPending || isStreaming}
        />
      </div>
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
      />
      <PaymentModal
        open={paymentModalOpen}
        onOpenChange={setPaymentModalOpen}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }}
      />
    </div>
  );
}
