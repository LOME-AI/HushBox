import * as React from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { SignupModal } from '@/components/auth/signup-modal';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { useSession } from '@/lib/auth';
import { useGuestChatStore, type GuestMessage } from '@/stores/guest-chat';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { useBalance } from '@/hooks/billing';
import { useGuestChatStream, GuestRateLimitError } from '@/hooks/use-guest-chat-stream';
import { useModelStore } from '@/stores/model';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import type { Document } from '@/lib/document-parser';

export const Route = createFileRoute('/_app/chat/guest')({
  component: GuestChatWithErrorBoundary,
});

function GuestChatWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <GuestChat />
    </ErrorBoundary>
  );
}

function GuestChat(): React.JSX.Element {
  // All hooks must be called before any conditional returns
  const viewportHeight = useVisualViewportHeight();
  const { data: session, isPending } = useSession();

  const { signupModalOpen, signupModalVariant, premiumModelName, setSignupModalOpen } =
    useUIModalsStore();

  const { data: modelsData } = useModels();
  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();
  const { data: balanceData } = useBalance();
  const { isStreaming, startStream } = useGuestChatStream();

  const {
    messages: guestMessages,
    pendingMessage,
    isRateLimited,
    addMessage,
    updateMessageContent,
    appendToMessage,
    clearPendingMessage,
    setRateLimited,
  } = useGuestChatStore();

  const [inputValue, setInputValue] = React.useState('');
  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null);
  const streamingMessageIdRef = React.useRef<string | null>(null);
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);
  const wasStreamingRef = React.useRef(false);

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

  const historyCharacters = React.useMemo(() => {
    return guestMessages.reduce((acc, m) => acc + m.content.length, 0);
  }, [guestMessages]);

  // Derived values (not hooks)
  const isAuthenticated = !isPending && Boolean(session?.user);
  const models = modelsData?.models ?? [];
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();
  const balance = parseFloat(balanceData?.balance ?? '0');
  const canAccessPremium = balance > 0; // Always false for guests

  const handlePremiumClick = usePremiumModelClick(models, false);

  const handleFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearPendingMessage();

      const userMessageId = crypto.randomUUID();
      const userMessage: GuestMessage = {
        id: userMessageId,
        conversationId: 'guest',
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      addMessage(userMessage);
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
              addMessage(assistantMessage);
              setStreamingMessageId(assistantMessageId);
              streamingMessageIdRef.current = assistantMessageId;
            },
            onToken: (token) => {
              const msgId = streamingMessageIdRef.current;
              if (msgId) {
                appendToMessage(msgId, token);
              }
            },
          }
        );

        if (result.assistantMessageId) {
          updateMessageContent(result.assistantMessageId, result.content);
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
      clearPendingMessage,
      addMessage,
      startStream,
      selectedModelId,
      appendToMessage,
      updateMessageContent,
      setRateLimited,
    ]
  );

  const handleSubmit = React.useCallback(async () => {
    const content = inputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    setInputValue('');

    const userMessageId = crypto.randomUUID();
    const userMessage: GuestMessage = {
      id: userMessageId,
      conversationId: 'guest',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };

    addMessage(userMessage);

    const apiMessages = [...guestMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

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
            addMessage(assistantMessage);
            setStreamingMessageId(assistantMessageId);
            streamingMessageIdRef.current = assistantMessageId;
          },
          onToken: (token) => {
            const msgId = streamingMessageIdRef.current;
            if (msgId) {
              appendToMessage(msgId, token);
            }
          },
        }
      );

      if (result.assistantMessageId) {
        updateMessageContent(result.assistantMessageId, result.content);
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
    guestMessages,
    selectedModelId,
    startStream,
    addMessage,
    appendToMessage,
    updateMessageContent,
    setRateLimited,
  ]);

  // Process pending message on mount (first message that triggered navigation here)
  React.useEffect(() => {
    if (pendingMessage && !creationStartedRef.current && !isStreaming) {
      creationStartedRef.current = true;
      void handleFirstMessage(pendingMessage);
    }
  }, [pendingMessage, isStreaming, handleFirstMessage]);

  // Focus input after streaming completes
  React.useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          promptInputRef.current?.focus();
        });
      });
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Redirect authenticated users to /chat
  if (!isPending && isAuthenticated) {
    return <Navigate to="/chat" />;
  }

  // Redirect to /chat if no pending message and no messages (user navigated here directly)
  if (!pendingMessage && guestMessages.length === 0 && !creationStartedRef.current) {
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
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={false}
        onPremiumClick={handlePremiumClick}
      />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageList
            messages={guestMessages}
            streamingMessageId={streamingMessageId}
            onDocumentsExtracted={handleDocumentsExtracted}
          />
        </div>
        <DocumentPanel documents={allDocuments} />
      </div>
      <div className="flex-shrink-0 border-t p-4">
        {isRateLimited && (
          <p className="text-destructive mb-2 text-center text-sm">
            You&apos;ve used all 5 free messages today. Sign up to continue chatting!
          </p>
        )}
        <PromptInput
          ref={promptInputRef}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={() => {
            void handleSubmit();
          }}
          placeholder="Type a message..."
          historyCharacters={historyCharacters}
          rows={2}
          minHeight="56px"
          maxHeight="112px"
          disabled={isStreaming || isRateLimited}
          isStreaming={isStreaming}
        />
      </div>
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
        variant={signupModalVariant}
      />
    </div>
  );
}
