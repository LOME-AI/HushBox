import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { VirtuosoHandle } from 'react-virtuoso';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import { useKeyboardOffset } from '@/hooks/use-keyboard-offset';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { useTierInfo } from '@/hooks/use-tier-info';
import { useModelStore } from '@/stores/model';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { billingKeys } from '@/hooks/billing';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';
import { ROUTES } from '@/lib/routes';

interface ChatLayoutProps {
  readonly title?: string | undefined;
  readonly messages: Message[];
  readonly streamingMessageId: string | null;
  readonly onDocumentsExtracted: (messageId: string, documents: Document[]) => void;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly inputDisabled: boolean;
  readonly isProcessing: boolean;
  readonly historyCharacters: number;
  readonly documents: Document[];
  readonly isAuthenticated: boolean;
  readonly rateLimitMessage?: React.ReactNode | undefined;
  readonly promptInputRef?: React.RefObject<PromptInputRef | null> | undefined;
}

interface MobileInputStyleInput {
  readonly isMobile: boolean;
  readonly keyboardOffset: number;
  readonly isKeyboardVisible: boolean;
}

function getMobileInputStyle(input: MobileInputStyleInput): React.CSSProperties | undefined {
  if (!input.isMobile) return undefined;
  return {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: `${String(input.keyboardOffset)}px`,
    paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
    transition: input.isKeyboardVisible ? 'none' : 'bottom 0.2s ease-out',
    zIndex: 10,
  };
}

export function ChatLayout({
  title,
  messages,
  streamingMessageId,
  onDocumentsExtracted,
  inputValue,
  onInputChange,
  onSubmit,
  inputDisabled,
  isProcessing,
  historyCharacters,
  documents,
  isAuthenticated,
  rateLimitMessage,
  promptInputRef: externalPromptInputRef,
}: ChatLayoutProps): React.JSX.Element {
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();
  const { bottom: keyboardOffset, isKeyboardVisible } = useKeyboardOffset();
  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();
  const { data: modelsData } = useModels();
  const models = React.useMemo(() => modelsData?.models ?? [], [modelsData?.models]);
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();
  const { canAccessPremium } = useTierInfo();
  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);
  const queryClient = useQueryClient();

  const internalPromptInputRef = React.useRef<PromptInputRef>(null);
  const promptInputRef = externalPromptInputRef ?? internalPromptInputRef;
  const previousInputDisabledRef = React.useRef(inputDisabled);
  const virtuosoRef = React.useRef<VirtuosoHandle>(null);
  const inputContainerRef = React.useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = React.useState(0);

  const handleSubmit = React.useCallback((): void => {
    onSubmit();
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    });
  }, [onSubmit]);

  React.useEffect(() => {
    const wasDisabled = previousInputDisabledRef.current;
    previousInputDisabledRef.current = inputDisabled;

    if (wasDisabled && !inputDisabled && !isMobile) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          promptInputRef.current?.focus();
        });
      });
    }
  }, [inputDisabled, isMobile, promptInputRef]);

  React.useEffect(() => {
    if (!isMobile || !inputContainerRef.current) return;

    const updateHeight = (): void => {
      if (inputContainerRef.current) {
        setInputHeight(inputContainerRef.current.offsetHeight);
      }
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(inputContainerRef.current);

    return (): void => {
      observer.disconnect();
    };
  }, [isMobile]);

  const {
    signupModalOpen,
    signupModalVariant,
    paymentModalOpen,
    premiumModelName,
    setSignupModalOpen,
    setPaymentModalOpen,
  } = useUIModalsStore();

  const inputStyle = getMobileInputStyle({ isMobile, keyboardOffset, isKeyboardVisible });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ height: `${String(viewportHeight)}px` }}
    >
      <div data-chat-header>
        <ChatHeader
          models={models}
          selectedModelId={selectedModelId}
          selectedModelName={selectedModelName}
          onModelSelect={setSelectedModel}
          title={title}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          onPremiumClick={handlePremiumClick}
        />
      </div>
      <div
        className="flex flex-1 overflow-hidden"
        style={isMobile && inputHeight > 0 ? { marginBottom: inputHeight } : undefined}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          {messages.length > 0 && (
            <MessageList
              ref={virtuosoRef}
              messages={messages}
              streamingMessageId={streamingMessageId}
              onDocumentsExtracted={onDocumentsExtracted}
            />
          )}
        </div>
        <DocumentPanel documents={documents} />
      </div>
      <div
        ref={inputContainerRef}
        data-chat-input
        className="bg-background flex-shrink-0 border-t p-4"
        style={inputStyle}
      >
        {rateLimitMessage && (
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
          onChange={onInputChange}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
          historyCharacters={historyCharacters}
          rows={2}
          minHeight="56px"
          maxHeight="112px"
          disabled={inputDisabled}
          isProcessing={isProcessing}
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
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }}
      />
    </div>
  );
}
