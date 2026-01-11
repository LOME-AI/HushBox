import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { NewChatPage } from '@/components/chat/new-chat-page';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { useSession } from '@/lib/auth';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { billingKeys, useBalance } from '@/hooks/billing';
import { useGuestChatStream, GuestRateLimitError } from '@/hooks/use-guest-chat-stream';
import { useModelStore } from '@/stores/model';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import type { Document } from '@/lib/document-parser';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatIndexWithErrorBoundary,
});

function ChatIndexWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ChatIndex />
    </ErrorBoundary>
  );
}

interface GuestMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export function ChatIndex(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const viewportHeight = useVisualViewportHeight();
  const { data: session, isPending } = useSession();
  const isAuthenticated = !isPending && Boolean(session?.user);
  useBalance();

  const {
    signupModalOpen,
    signupModalVariant,
    paymentModalOpen,
    premiumModelName,
    setSignupModalOpen,
    setPaymentModalOpen,
  } = useUIModalsStore();

  const { data: modelsData } = useModels();
  const models = modelsData?.models ?? [];
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();

  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();
  const { data: balanceData } = useBalance();
  const balance = parseFloat(balanceData?.balance ?? '0');
  const canAccessPremium = isAuthenticated && balance > 0;
  const { isStreaming, startStream } = useGuestChatStream();

  const [guestMessages, setGuestMessages] = React.useState<GuestMessage[]>([]);
  const [guestInputValue, setGuestInputValue] = React.useState('');
  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null);
  const [isRateLimited, setIsRateLimited] = React.useState(false);
  const streamingMessageIdRef = React.useRef<string | null>(null);
  const guestPromptInputRef = React.useRef<PromptInputRef>(null);

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

  const hasGuestMessages = guestMessages.length > 0;
  const selectedModel = models.find((m) => m.id === selectedModelId);

  // Ref to get latest session at call time - avoids stale closure in handleSend
  const sessionRef = React.useRef(session);
  sessionRef.current = session;

  const handleGuestFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      if (isStreaming || isRateLimited) return;

      const userMessageId = crypto.randomUUID();
      const userMessage: GuestMessage = {
        id: userMessageId,
        conversationId: 'guest',
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      setGuestMessages([userMessage]);
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
              setGuestMessages((prev) => [...prev, assistantMessage]);
              setStreamingMessageId(assistantMessageId);
              streamingMessageIdRef.current = assistantMessageId;
            },
            onToken: (token) => {
              const msgId = streamingMessageIdRef.current;
              if (msgId) {
                setGuestMessages((prev) =>
                  prev.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
                );
              }
            },
          }
        );

        if (result.assistantMessageId) {
          setGuestMessages((prev) =>
            prev.map((m) =>
              m.id === result.assistantMessageId ? { ...m, content: result.content } : m
            )
          );
        }

        setStreamingMessageId(null);
        streamingMessageIdRef.current = null;
      } catch (error) {
        setStreamingMessageId(null);
        streamingMessageIdRef.current = null;

        if (error instanceof GuestRateLimitError) {
          setIsRateLimited(true);
          useUIModalsStore.getState().openSignupModal(undefined, 'rate-limit');
        } else {
          console.error('Guest chat error:', error);
        }
      }
    },
    [isStreaming, isRateLimited, selectedModelId, startStream]
  );

  // Routes to /chat/new for authenticated users, handles locally for guests
  const handleSend = React.useCallback(
    (content: string): void => {
      const currentSession = sessionRef.current;
      const isUserAuthenticated = Boolean(currentSession?.user.id);
      if (isUserAuthenticated) {
        usePendingChatStore.getState().setPendingMessage(content);
        void navigate({ to: '/chat/new' });
      } else {
        void handleGuestFirstMessage(content);
      }
    },
    [navigate, handleGuestFirstMessage]
  );
  const handleGuestSubmit = React.useCallback(async () => {
    const content = guestInputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    setGuestInputValue('');

    const userMessageId = crypto.randomUUID();
    const userMessage: GuestMessage = {
      id: userMessageId,
      conversationId: 'guest',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };

    setGuestMessages((prev) => [...prev, userMessage]);

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
            setGuestMessages((prev) => [...prev, assistantMessage]);
            setStreamingMessageId(assistantMessageId);
            streamingMessageIdRef.current = assistantMessageId;
          },
          onToken: (token) => {
            const msgId = streamingMessageIdRef.current;
            if (msgId) {
              setGuestMessages((prev) =>
                prev.map((m) => (m.id === msgId ? { ...m, content: m.content + token } : m))
              );
            }
          },
        }
      );

      if (result.assistantMessageId) {
        setGuestMessages((prev) =>
          prev.map((m) =>
            m.id === result.assistantMessageId ? { ...m, content: result.content } : m
          )
        );
      }

      setStreamingMessageId(null);
      streamingMessageIdRef.current = null;
    } catch (error) {
      setStreamingMessageId(null);
      streamingMessageIdRef.current = null;

      if (error instanceof GuestRateLimitError) {
        setIsRateLimited(true);
        useUIModalsStore.getState().openSignupModal(undefined, 'rate-limit');
      } else {
        console.error('Guest chat error:', error);
      }
    }
  }, [guestInputValue, isStreaming, isRateLimited, guestMessages, selectedModelId, startStream]);

  const historyTokens = React.useMemo(() => {
    return guestMessages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
  }, [guestMessages]);

  // Focus guest input after streaming completes
  const wasGuestStreamingRef = React.useRef(false);

  React.useEffect(() => {
    if (wasGuestStreamingRef.current && !isStreaming) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          guestPromptInputRef.current?.focus();
        });
      });
    }
    wasGuestStreamingRef.current = isStreaming;
  }, [isStreaming]);

  if (hasGuestMessages) {
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
            ref={guestPromptInputRef}
            value={guestInputValue}
            onChange={setGuestInputValue}
            onSubmit={() => {
              void handleGuestSubmit();
            }}
            placeholder="Type a message..."
            modelContextLimit={selectedModel?.contextLength}
            historyTokens={historyTokens}
            rows={2}
            minHeight="56px"
            maxHeight="112px"
            disabled={isStreaming || isRateLimited}
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

  // Initial view - same UI for guests and authenticated users
  // Auth status is checked at send time, not render time
  // Input is disabled while isPending, preventing race conditions
  return (
    <div className="flex h-full flex-col">
      <NewChatPage
        onSend={handleSend}
        isAuthenticated={isAuthenticated}
        isLoading={isPending}
        onPremiumClick={handlePremiumClick}
      />
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
        variant={signupModalVariant}
      />
      {isAuthenticated && (
        <PaymentModal
          open={paymentModalOpen}
          onOpenChange={setPaymentModalOpen}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }}
        />
      )}
    </div>
  );
}
