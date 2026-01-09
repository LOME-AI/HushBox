import * as React from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { useCreateConversation, useChatStream, chatKeys } from '@/hooks/chat';
import { billingKeys, useBalance } from '@/hooks/billing';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useModels } from '@/hooks/models';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';

export const Route = createFileRoute('/_app/chat/new')({
  component: ChatNew,
});

export function ChatNew(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const viewportHeight = useVisualViewportHeight();

  // Auth state for premium access
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const { data: balanceData } = useBalance();
  const balance = parseFloat(balanceData?.balance ?? '0');
  const canAccessPremium = isAuthenticated && balance > 0;

  // Use Zustand store for pending message (synchronous, no race condition)
  const pendingMessage = usePendingChatStore((s) => s.pendingMessage);
  const clearPendingMessage = usePendingChatStore((s) => s.clearPendingMessage);

  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();
  const { data: modelsData } = useModels();
  const models = modelsData?.models ?? [];
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();
  const createConversation = useCreateConversation();
  const { isStreaming, startStream } = useChatStream();

  // Signup modal state for premium model access (guests)
  const [showSignupModal, setShowSignupModal] = React.useState(false);
  // Payment modal state for free users (authenticated but no balance)
  const [showPaymentModal, setShowPaymentModal] = React.useState(false);
  const [premiumModelName, setPremiumModelName] = React.useState<string | undefined>();

  const handlePremiumClick = (modelId: string): void => {
    const model = models.find((m) => m.id === modelId);
    setPremiumModelName(model?.name);

    if (isAuthenticated) {
      // Free user (authenticated but no balance) -> show add credits
      setShowPaymentModal(true);
    } else {
      // Guest -> show signup
      setShowSignupModal(true);
    }
  };

  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [inputValue, setInputValue] = React.useState('');

  // Track which message is currently streaming
  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null);

  // Messages including user's pending message and streaming assistant response
  const [messages, setMessages] = React.useState<Message[]>([]);

  // Track if we've already started the creation process and capture the message
  const creationStartedRef = React.useRef(false);
  const capturedMessageRef = React.useRef<string | null>(null);

  // Ref to track streaming message ID for use in callbacks
  const streamingMessageIdRef = React.useRef<string | null>(null);

  // Ref to track current messages for cache seeding (avoids stale closure in async IIFE)
  const messagesRef = React.useRef<Message[]>([]);

  // Track documents extracted from messages
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

  // Keep messagesRef in sync with state for cache seeding
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Create conversation on mount if we have a pending message
  React.useEffect(() => {
    if (!pendingMessage || creationStartedRef.current) {
      return;
    }

    creationStartedRef.current = true;
    capturedMessageRef.current = pendingMessage;

    // Create optimistic user message immediately
    const userMessage: Message = {
      id: 'pending-user-message',
      conversationId: 'pending',
      role: 'user',
      content: pendingMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages([userMessage]);

    // Use mutateAsync instead of mutate with inline callbacks to avoid stale closure issues
    void (async () => {
      try {
        const response = await createConversation.mutateAsync({
          firstMessage: { content: pendingMessage },
        });

        const newConversationId = response.conversation.id;
        setConversationId(newConversationId);

        // Update user message with real ID
        const realUserMessage: Message = {
          id: response.message?.id ?? 'pending-user-message',
          conversationId: newConversationId,
          role: 'user',
          content: pendingMessage,
          createdAt: response.message?.createdAt ?? new Date().toISOString(),
        };
        setMessages([realUserMessage]);

        // Seed the cache so chat.$conversationId.tsx doesn't show loading
        queryClient.setQueryData(chatKeys.conversation(newConversationId), response.conversation);
        queryClient.setQueryData(
          chatKeys.messages(newConversationId),
          response.message ? [response.message] : []
        );

        // Clear pending message from store
        clearPendingMessage();

        // Start streaming
        try {
          await startStream(
            { conversationId: newConversationId, model: selectedModelId },
            {
              onStart: ({ assistantMessageId: msgId }) => {
                // Add empty assistant message
                const assistantMessage: Message = {
                  id: msgId,
                  conversationId: newConversationId,
                  role: 'assistant',
                  content: '',
                  createdAt: new Date().toISOString(),
                };
                setMessages((prev) => [...prev, assistantMessage]);
                setStreamingMessageId(msgId);
                streamingMessageIdRef.current = msgId;
              },
              onToken: (token) => {
                // Update assistant message content in-place
                const msgId = streamingMessageIdRef.current;
                if (msgId) {
                  setMessages((prev) =>
                    prev.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
                  );
                }
              },
            }
          );

          // Wait for billing to complete (fire-and-forget async)
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Seed cache with complete message content from local state
          // This prevents flash - destination shows this immediately
          queryClient.setQueryData(chatKeys.messages(newConversationId), messagesRef.current);

          // Mark stale so destination refetches for cost in background
          void queryClient.invalidateQueries({ queryKey: chatKeys.messages(newConversationId) });
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          setStreamingMessageId(null);
          streamingMessageIdRef.current = null;

          // Navigate - destination shows cached content, refetches cost in background
          void navigate({
            to: '/chat/$conversationId',
            params: { conversationId: newConversationId },
            replace: true,
          });
        } catch (streamError: unknown) {
          console.error('Stream failed:', streamError);
          setStreamingMessageId(null);
          streamingMessageIdRef.current = null;
        }
      } catch {
        // Keep pending message in store so it can be restored, then navigate back
        void navigate({ to: '/chat' });
      }
    })();
  }, [
    pendingMessage,
    createConversation,
    selectedModelId,
    startStream,
    queryClient,
    navigate,
    clearPendingMessage,
  ]);

  // Redirect to /chat if no pending message AND we haven't started creating
  // (once creation starts, we stay on this page even after clearing the pending message)
  if (pendingMessage === null && !creationStartedRef.current) {
    return <Navigate to="/chat" />;
  }

  const selectedModel = models.find((m) => m.id === selectedModelId);

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
      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            streamingMessageId={streamingMessageId}
            onDocumentsExtracted={handleDocumentsExtracted}
          />
        </div>
        <DocumentPanel documents={allDocuments} />
      </div>
      <div className="flex-shrink-0 border-t p-4">
        <PromptInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={() => {
            // Can't send another message until conversation is created and streaming is done
          }}
          placeholder="Type a message..."
          modelContextLimit={selectedModel?.contextLength}
          historyTokens={0}
          rows={2}
          minHeight="56px"
          maxHeight="112px"
          disabled={createConversation.isPending || isStreaming || !conversationId}
        />
      </div>
      <SignupModal
        open={showSignupModal}
        onOpenChange={setShowSignupModal}
        modelName={premiumModelName}
      />
      <PaymentModal
        open={showPaymentModal}
        onOpenChange={setShowPaymentModal}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }}
      />
    </div>
  );
}
