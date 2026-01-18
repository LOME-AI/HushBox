import * as React from 'react';
import { createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router';
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
  useCreateConversation,
  chatKeys,
} from '@/hooks/chat';
import { useChatStream, GuestRateLimitError } from '@/hooks/use-chat-stream';
import { useGuestChatStore, type GuestMessage } from '@/stores/guest-chat';
import { billingKeys } from '@/hooks/billing';
import { useSession } from '@/lib/auth';
import { usePendingChatStore } from '@/stores/pending-chat';
import { generateChatTitle } from '@lome-chat/shared';
import { useTierInfo } from '@/hooks/use-tier-info';
import { useModelStore } from '@/stores/model';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import { useKeyboardOffset } from '@/hooks/use-keyboard-offset';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';
import { ROUTES } from '@/lib/routes';

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

export function ChatConversation(): React.JSX.Element {
  const { conversationId: routeConversationId } = Route.useParams();
  const { triggerStreaming } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();
  const { bottom: keyboardOffset, isKeyboardVisible } = useKeyboardOffset();

  // Route type detection
  const isNewChat = routeConversationId === 'new';
  const isGuestChat = routeConversationId === 'guest';
  const isExistingChat = !isNewChat && !isGuestChat;

  // For new chats: get pending message from store
  const pendingMessage = usePendingChatStore((s) => s.pendingMessage);
  const clearPendingMessage = usePendingChatStore((s) => s.clearPendingMessage);

  // Guest chat store
  const {
    messages: guestMessages,
    pendingMessage: guestPendingMessage,
    isRateLimited,
    addMessage: addGuestMessage,
    updateMessageContent: updateGuestMessageContent,
    appendToMessage: appendToGuestMessage,
    clearPendingMessage: clearGuestPendingMessage,
    setRateLimited,
  } = useGuestChatStore();

  // Track the real conversation ID (null for new/guest chats until created)
  const [realConversationId, setRealConversationId] = React.useState<string | null>(
    isExistingChat ? routeConversationId : null
  );

  // The effective conversation ID for API calls
  const conversationId = realConversationId ?? '';

  // Local messages for new chat mode (before conversation exists)
  const [localMessages, setLocalMessages] = React.useState<Message[]>([]);

  // Local title for new chat mode (persists after pendingMessage is cleared)
  const [localTitle, setLocalTitle] = React.useState<string | null>(null);

  // Ref to track current local messages for cache seeding
  const localMessagesRef = React.useRef<Message[]>([]);
  React.useEffect(() => {
    localMessagesRef.current = localMessages;
  }, [localMessages]);

  // Track if conversation creation has started
  const creationStartedRef = React.useRef(false);

  const createConversation = useCreateConversation();

  // Fixed input height for mobile (input container height + safe area)
  const MOBILE_INPUT_HEIGHT = 80;

  // Calculate mobile bottom padding: input height + 1/6 viewport for comfortable scrolling
  const mobileBottomPadding = MOBILE_INPUT_HEIGHT + Math.floor(viewportHeight / 6);

  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);
  const { canAccessPremium } = useTierInfo();

  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();

  const { data: modelsData } = useModels();
  const models = React.useMemo(() => modelsData?.models ?? [], [modelsData?.models]);
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();

  const {
    signupModalOpen,
    signupModalVariant,
    paymentModalOpen,
    premiumModelName,
    setSignupModalOpen,
    setPaymentModalOpen,
  } = useUIModalsStore();

  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  // Only fetch from API if we have a real conversation ID (not guest)
  const { data: conversation, isLoading: isConversationLoading } = useConversation(
    isGuestChat ? '' : (realConversationId ?? '')
  );
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(
    isGuestChat ? '' : (realConversationId ?? '')
  );

  const sendMessage = useSendMessage();

  // Use unified stream hook with appropriate mode
  const streamMode = isGuestChat ? 'guest' : 'authenticated';
  const { isStreaming, startStream } = useChatStream(streamMode);

  // No loading state for new/guest chats - we use local state
  // For existing conversations, check if we're still fetching
  const isLoading =
    isExistingChat && realConversationId !== null && (isConversationLoading || isMessagesLoading);

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
    // For guest chats, use guest messages from Zustand store
    if (isGuestChat) {
      return guestMessages as Message[];
    }
    // For new chats, use local messages until we have a real conversation
    if (!realConversationId) {
      return localMessages;
    }
    // For existing conversations, combine API messages with optimistic updates
    const messages = apiMessages ?? [];
    const apiMessageIds = new Set(messages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    return [...messages, ...pendingOptimistic];
  }, [
    isGuestChat,
    guestMessages,
    realConversationId,
    localMessages,
    apiMessages,
    optimisticMessages,
  ]);

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

  // Focus input when arriving on a newly-created conversation
  // (streaming completed in chat.new, we're arriving with cached data)
  // Skip on mobile to avoid triggering keyboard unexpectedly
  const hasInitialFocusedRef = React.useRef(false);

  // Sync realConversationId when navigating between existing conversations
  // This handles the case where route param changes but component doesn't remount
  React.useEffect(() => {
    if (isExistingChat && routeConversationId !== realConversationId) {
      setRealConversationId(routeConversationId);
      // Reset state for new conversation
      setOptimisticMessages([]);
      setLocalMessages([]);
      setLocalTitle(null);
      setDocumentsByMessage({});
      setStreamingMessageId(null);
      streamingMessageIdRef.current = null;
      // Reset creation tracking for the new conversation context
      creationStartedRef.current = false;
      // Reset focus tracking so input can be focused after load
      hasInitialFocusedRef.current = false;
    }
  }, [isExistingChat, routeConversationId, realConversationId]);

  React.useEffect(() => {
    if (hasInitialFocusedRef.current || isMobile) return;

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
  }, [isLoading, isStreaming, allMessages.length, isMobile]);

  // Guest chat: Handle first message from pending
  const handleGuestFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearGuestPendingMessage();

      const userMessageId = crypto.randomUUID();
      const userMessage: GuestMessage = {
        id: userMessageId,
        conversationId: 'guest',
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      addGuestMessage(userMessage);
      const apiMessages = [{ role: 'user' as const, content }];

      try {
        const result = await startStream(
          {
            messages: apiMessages,
            model: selectedModelId,
          },
          {
            onStart: ({ assistantMessageId }) => {
              const assistantMessage: GuestMessage = {
                id: assistantMessageId,
                conversationId: 'guest',
                role: 'assistant',
                content: '',
                createdAt: new Date().toISOString(),
              };
              addGuestMessage(assistantMessage);
              setStreamingMessageId(assistantMessageId);
              streamingMessageIdRef.current = assistantMessageId;
            },
            onToken: (token) => {
              const msgId = streamingMessageIdRef.current;
              if (msgId) {
                appendToGuestMessage(msgId, token);
              }
            },
          }
        );

        if (result.assistantMessageId) {
          updateGuestMessageContent(result.assistantMessageId, result.content);
        }

        setStreamingMessageId(null);
        streamingMessageIdRef.current = null;
      } catch (error) {
        setStreamingMessageId(null);
        streamingMessageIdRef.current = null;

        if (error instanceof GuestRateLimitError) {
          setRateLimited(true);
          useUIModalsStore.getState().openSignupModal(undefined, 'rate-limit');
        } else {
          console.error('Guest chat error:', error);
        }
      }
    },
    [
      clearGuestPendingMessage,
      addGuestMessage,
      startStream,
      selectedModelId,
      appendToGuestMessage,
      updateGuestMessageContent,
      setRateLimited,
    ]
  );

  // Guest chat: Process pending message on mount
  React.useEffect(() => {
    if (isGuestChat && guestPendingMessage && !creationStartedRef.current && !isStreaming) {
      creationStartedRef.current = true;
      void handleGuestFirstMessage(guestPendingMessage);
    }
  }, [isGuestChat, guestPendingMessage, isStreaming, handleGuestFirstMessage]);

  // New chat creation effect - handles /chat/new with pending message
  React.useEffect(() => {
    if (!isNewChat || !pendingMessage || creationStartedRef.current) {
      return;
    }

    creationStartedRef.current = true;

    // Show user message immediately in local state
    const userMessage: Message = {
      id: 'pending-user-message',
      conversationId: 'pending',
      role: 'user',
      content: pendingMessage,
      createdAt: new Date().toISOString(),
    };
    setLocalMessages([userMessage]);

    void (async () => {
      try {
        const response = await createConversation.mutateAsync({
          firstMessage: { content: pendingMessage },
        });

        const newConversationId = response.conversation.id;

        // Update local message with real IDs
        const realUserMessage: Message = {
          id: response.message?.id ?? 'pending-user-message',
          conversationId: newConversationId,
          role: 'user',
          content: pendingMessage,
          createdAt: response.message?.createdAt ?? new Date().toISOString(),
        };
        setLocalMessages([realUserMessage]);

        setLocalTitle(generateChatTitle(pendingMessage));
        clearPendingMessage();

        try {
          await startStream(
            { conversationId: newConversationId, model: selectedModelId },
            {
              onStart: ({ assistantMessageId }) => {
                const assistantMessage: Message = {
                  id: assistantMessageId,
                  conversationId: newConversationId,
                  role: 'assistant',
                  content: '',
                  createdAt: new Date().toISOString(),
                };
                setLocalMessages((prev) => [...prev, assistantMessage]);
                setStreamingMessageId(assistantMessageId);
                streamingMessageIdRef.current = assistantMessageId;
              },
              onToken: (token) => {
                const msgId = streamingMessageIdRef.current;
                if (msgId) {
                  setLocalMessages((prev) =>
                    prev.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
                  );
                }
                if (isAutoScrollEnabledRef.current) {
                  scrollToBottom();
                }
              },
            }
          );

          // Wait for billing to complete
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Seed cache for future page refreshes
          queryClient.setQueryData(chatKeys.conversation(newConversationId), response.conversation);
          queryClient.setQueryData(chatKeys.messages(newConversationId), localMessagesRef.current);

          // Invalidate to refetch with costs
          void queryClient.invalidateQueries({ queryKey: chatKeys.messages(newConversationId) });
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          setStreamingMessageId(null);
          streamingMessageIdRef.current = null;

          // Navigate to real conversation URL after streaming completes
          setRealConversationId(newConversationId);
          void navigate({
            to: '/chat/$conversationId',
            params: { conversationId: newConversationId },
            replace: true,
          });
        } catch (streamError: unknown) {
          console.error('Stream failed:', streamError);
          setStreamingMessageId(null);
          streamingMessageIdRef.current = null;

          // Still navigate even on stream error - conversation was created
          setRealConversationId(newConversationId);
          void navigate({
            to: '/chat/$conversationId',
            params: { conversationId: newConversationId },
            replace: true,
          });
        }
      } catch {
        // Creation failed - navigate back to chat index
        void navigate({ to: '/chat' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isAutoScrollEnabledRef is a stable ref
  }, [
    isNewChat,
    pendingMessage,
    createConversation,
    selectedModelId,
    startStream,
    queryClient,
    navigate,
    clearPendingMessage,
    scrollToBottom,
  ]);

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

  // Guest chat: Handle follow-up messages
  const handleGuestSubmit = React.useCallback(async () => {
    const content = inputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    setInputValue('');
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    const userMessageId = crypto.randomUUID();
    const userMessage: GuestMessage = {
      id: userMessageId,
      conversationId: 'guest',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };

    addGuestMessage(userMessage);

    const apiMessagesPayload = [...guestMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const result = await startStream(
        {
          messages: apiMessagesPayload,
          model: selectedModelId,
        },
        {
          onStart: ({ assistantMessageId }) => {
            const assistantMessage: GuestMessage = {
              id: assistantMessageId,
              conversationId: 'guest',
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            };
            addGuestMessage(assistantMessage);
            setStreamingMessageId(assistantMessageId);
            streamingMessageIdRef.current = assistantMessageId;
          },
          onToken: (token) => {
            const msgId = streamingMessageIdRef.current;
            if (msgId) {
              appendToGuestMessage(msgId, token);
            }
          },
        }
      );

      if (result.assistantMessageId) {
        updateGuestMessageContent(result.assistantMessageId, result.content);
      }

      setStreamingMessageId(null);
      streamingMessageIdRef.current = null;
    } catch (error) {
      setStreamingMessageId(null);
      streamingMessageIdRef.current = null;

      if (error instanceof GuestRateLimitError) {
        setRateLimited(true);
        useUIModalsStore.getState().openSignupModal(undefined, 'rate-limit');
      } else {
        console.error('Guest chat error:', error);
      }
    }
  }, [
    inputValue,
    isStreaming,
    isRateLimited,
    isMobile,
    guestMessages,
    selectedModelId,
    startStream,
    addGuestMessage,
    appendToGuestMessage,
    updateGuestMessageContent,
    setRateLimited,
  ]);

  // Authenticated chat: Handle follow-up messages
  const handleAuthenticatedSend = (): void => {
    const content = inputValue.trim();
    // Block sending if no content or no real conversation yet (still in creation)
    if (!content || !realConversationId) {
      return;
    }

    setInputValue('');
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

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
            });
        },
        onError: () => {
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticUserMessage.id));
          promptInputRef.current?.focus();
        },
      }
    );
  };

  // Unified send handler
  const handleSend = isGuestChat ? () => void handleGuestSubmit() : handleAuthenticatedSend;

  // Guest: Redirect authenticated users to /chat
  if (isGuestChat && !isSessionPending && isAuthenticated) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  // Guest: Redirect to /chat if no pending message and no messages (user navigated here directly)
  if (
    isGuestChat &&
    !guestPendingMessage &&
    guestMessages.length === 0 &&
    !creationStartedRef.current
  ) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  // Redirect if /chat/new with no pending message and creation hasn't started
  if (isNewChat && !pendingMessage && !creationStartedRef.current) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (isLoading) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        style={{ height: `${String(viewportHeight)}px` }}
      >
        <ChatHeader
          title={conversation?.title}
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
          variant={signupModalVariant}
        />
        <PaymentModal
          open={paymentModalOpen}
          onOpenChange={setPaymentModalOpen}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: billingKeys.balance() }).catch(console.error);
          }}
        />
      </div>
    );
  }

  // Only redirect if we have a real conversation ID but no conversation data
  // (meaning API fetch failed or conversation was deleted)
  // Don't redirect for new/guest chats - we use local state
  if (isExistingChat && realConversationId && !conversation && !isConversationLoading) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  // Use local title for new chats (set before pendingMessage is cleared)
  const displayTitle = conversation?.title ?? localTitle ?? undefined;

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
        title={displayTitle}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={!isGuestChat && isAuthenticated}
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
              bottomPadding={isMobile ? mobileBottomPadding : undefined}
            />
          )}
        </div>
        <DocumentPanel documents={allDocuments} />
      </div>
      <div
        className="bg-background flex-shrink-0 border-t p-4"
        style={
          isMobile
            ? {
                position: 'fixed',
                left: 0,
                right: 0,
                bottom: `${String(keyboardOffset)}px`,
                paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
                transition: isKeyboardVisible ? 'none' : 'bottom 0.2s ease-out',
                zIndex: 10,
              }
            : undefined
        }
      >
        {isGuestChat && isRateLimited && (
          <p className="text-destructive mb-2 text-center text-sm">
            You&apos;ve used all 5 free messages today.{' '}
            <Link to={ROUTES.SIGNUP} className="text-primary hover:underline">
              Sign up
            </Link>{' '}
            to continue chatting!
          </p>
        )}
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
          disabled={isGuestChat ? isRateLimited : !realConversationId}
          isProcessing={isStreaming}
        />
      </div>
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
        variant={signupModalVariant}
      />
      <PaymentModal
        open={paymentModalOpen}
        onOpenChange={setPaymentModalOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: billingKeys.balance() }).catch(console.error);
        }}
      />
    </div>
  );
}
