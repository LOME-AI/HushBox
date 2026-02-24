import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { VirtuosoHandle } from 'react-virtuoso';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import type { PromptInputRef } from '@/components/chat/prompt-input';
import { DocumentPanel } from '@/components/document-panel/document-panel';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { MemberSidebar } from '@/components/chat/member-sidebar';
import { AddMemberModal } from '@/components/chat/add-member-modal';
import { BudgetSettingsModal } from '@/components/chat/budget-settings-modal';
import { InviteLinkModal } from '@/components/chat/invite-link-modal';
import { ShareMessageModal } from '@/components/chat/share-message-modal';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import { useKeyboardOffset } from '@/hooks/use-keyboard-offset';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { useTierInfo } from '@/hooks/use-tier-info';
import { useModelStore } from '@/stores/model';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { billingKeys } from '@/hooks/billing';
import { TypingIndicator } from '@/components/chat/typing-indicator';
import { Lock } from 'lucide-react';
import { createEvent } from '@hushbox/realtime/events';
import type { FundingSource } from '@hushbox/shared';
import { useDocumentStore } from '@/stores/document';
import type { Message } from '@/lib/api';
import type { PhantomMessage } from '@/hooks/use-remote-streaming';
import type { ConversationWebSocket } from '@/lib/ws-client';

export interface GroupChatProps {
  readonly conversationId: string;
  readonly members: {
    id: string;
    userId: string;
    username: string;
    privilege: string;
  }[];
  readonly links: {
    id: string;
    displayName: string | null;
    privilege: string;
    createdAt: string;
  }[];
  readonly onlineMemberIds: Set<string>;
  readonly currentUserId: string;
  readonly currentUserPrivilege: string;
  readonly currentEpochPrivateKey: Uint8Array;
  readonly currentEpochNumber: number;
  readonly typingUserIds?: Set<string> | undefined;
  readonly remoteStreamingMessages?: Map<string, PhantomMessage> | undefined;
  readonly ws?: ConversationWebSocket | undefined;
  readonly onRemoveMember?: ((memberId: string) => void) | undefined;
  readonly onChangePrivilege?: ((memberId: string, newPrivilege: string) => void) | undefined;
  readonly onRevokeLinkClick?: ((linkId: string) => void) | undefined;
  readonly onSaveLinkName?: ((linkId: string, newName: string) => void) | undefined;
  readonly onChangeLinkPrivilege?: ((linkId: string, newPrivilege: string) => void) | undefined;
  readonly onAddMember?:
    | ((params: {
        userId: string;
        username: string;
        publicKey: string;
        privilege: string;
        giveFullHistory: boolean;
      }) => void)
    | undefined;
  readonly onLeave?: (() => void) | undefined;
}

interface ChatLayoutProps {
  readonly title?: string | undefined;
  readonly messages: Message[];
  readonly streamingMessageId: string | null;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: (fundingSource: FundingSource) => void;
  readonly onSubmitUserOnly?: (() => void) | undefined;
  readonly inputDisabled: boolean;
  readonly isProcessing: boolean;
  readonly historyCharacters: number;
  readonly isAuthenticated: boolean;
  readonly promptInputRef?: React.RefObject<PromptInputRef | null> | undefined;
  readonly errorMessageId?: string | undefined;
  readonly isDecrypting?: boolean | undefined;
  readonly conversationId?: string | undefined;
  readonly groupChat?: GroupChatProps | undefined;
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

interface GroupChatModalsProps {
  groupChat: GroupChatProps;
  addMemberModalOpen: boolean;
  closeAddMemberModal: () => void;
  budgetSettingsModalOpen: boolean;
  closeBudgetSettingsModal: () => void;
  inviteLinkModalOpen: boolean;
  closeInviteLinkModal: () => void;
}

function GroupChatModals({
  groupChat,
  addMemberModalOpen,
  closeAddMemberModal,
  budgetSettingsModalOpen,
  closeBudgetSettingsModal,
  inviteLinkModalOpen,
  closeInviteLinkModal,
}: Readonly<GroupChatModalsProps>): React.JSX.Element {
  return (
    <>
      <AddMemberModal
        open={addMemberModalOpen}
        onOpenChange={(open) => {
          if (!open) closeAddMemberModal();
        }}
        conversationId={groupChat.conversationId}
        memberCount={groupChat.members.length + groupChat.links.length}
        onAddMember={
          groupChat.onAddMember ??
          (() => {
            /* noop */
          })
        }
      />
      <BudgetSettingsModal
        open={budgetSettingsModalOpen}
        onOpenChange={(open) => {
          if (!open) closeBudgetSettingsModal();
        }}
        conversationId={groupChat.conversationId}
        members={groupChat.members.map((m) => ({
          id: m.id,
          userId: m.userId,
          username: m.username,
          privilege: m.privilege,
        }))}
        currentUserPrivilege={groupChat.currentUserPrivilege}
      />
      <InviteLinkModal
        open={inviteLinkModalOpen}
        onOpenChange={(open) => {
          if (!open) closeInviteLinkModal();
        }}
        conversationId={groupChat.conversationId}
        currentEpochPrivateKey={groupChat.currentEpochPrivateKey}
        memberCount={groupChat.members.length + groupChat.links.length}
      />
    </>
  );
}

function buildMemberSidebarProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MemberSidebar>> {
  if (groupChat === undefined) return {};
  return {
    members: groupChat.members,
    links: groupChat.links,
    onlineMemberIds: groupChat.onlineMemberIds,
    currentUserId: groupChat.currentUserId,
    currentUserPrivilege: groupChat.currentUserPrivilege,
    ...(groupChat.onRemoveMember !== undefined && {
      onRemoveMember: groupChat.onRemoveMember,
    }),
    ...(groupChat.onChangePrivilege !== undefined && {
      onChangePrivilege: groupChat.onChangePrivilege,
    }),
    ...(groupChat.onRevokeLinkClick !== undefined && {
      onRevokeLinkClick: groupChat.onRevokeLinkClick,
    }),
    ...(groupChat.onSaveLinkName !== undefined && {
      onSaveLinkName: groupChat.onSaveLinkName,
    }),
    ...(groupChat.onChangeLinkPrivilege !== undefined && {
      onChangeLinkPrivilege: groupChat.onChangeLinkPrivilege,
    }),
    ...(groupChat.onLeave !== undefined && { onLeaveClick: groupChat.onLeave }),
  };
}

function useInputFocusManagement(
  inputDisabled: boolean,
  isMobile: boolean,
  promptInputRef: React.RefObject<PromptInputRef | null>
): void {
  const previousInputDisabledRef = React.useRef(inputDisabled);

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
}

function useStreamScrollEffect(
  streamingMessageId: string | null,
  messagesLength: number,
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
): void {
  const previousStreamingIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const wasStreaming = previousStreamingIdRef.current !== null;
    const isNowStreaming = streamingMessageId !== null;
    previousStreamingIdRef.current = streamingMessageId;

    const isFirstMessage = messagesLength <= 2;

    if (!wasStreaming && isNowStreaming && isFirstMessage) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      });
    }
  }, [streamingMessageId, messagesLength, virtuosoRef]);
}

interface ChatLayoutDerivedInput {
  readonly modelsData: { premiumIds: Set<string> } | undefined;
  readonly tierInfo: { canAccessPremium: boolean } | undefined;
  readonly shareMessageId: string | null;
  readonly messages: Message[];
}

interface ChatLayoutDerivedState {
  premiumIds: Set<string>;
  canAccessPremium: boolean;
  sharedMessageContent: string | null;
}

function resolveChatLayoutDerivedState(input: ChatLayoutDerivedInput): ChatLayoutDerivedState {
  const sharedMessage = input.shareMessageId
    ? (input.messages.find((m) => m.id === input.shareMessageId) ?? null)
    : null;
  return {
    premiumIds: input.modelsData?.premiumIds ?? new Set<string>(),
    canAccessPremium: input.tierInfo?.canAccessPremium ?? false,
    sharedMessageContent: sharedMessage?.content ?? null,
  };
}

interface ChatPromptInputProps {
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  readonly handleSubmit: (fundingSource: FundingSource) => void;
  readonly historyCharacters: number;
  readonly inputDisabled: boolean;
  readonly isProcessing: boolean;
  readonly isMobile: boolean;
  readonly groupChat: GroupChatProps | undefined;
  readonly handleSubmitUserOnly: () => void;
  readonly handleTypingChange: (isTyping: boolean) => void;
}

interface ChatHeaderGroupProps {
  members?: { id: string; username: string }[] | undefined;
  onlineMemberIds?: Set<string> | undefined;
  onFacepileClick?: (() => void) | undefined;
}

function buildChatHeaderGroupProps(
  groupChat: GroupChatProps | undefined,
  onFacepileClick: () => void
): ChatHeaderGroupProps {
  if (!groupChat) return {};
  return {
    members: groupChat.members,
    onlineMemberIds: groupChat.onlineMemberIds,
    onFacepileClick,
  };
}

function ChatPromptInput({
  promptInputRef,
  inputValue,
  onInputChange,
  handleSubmit,
  historyCharacters,
  inputDisabled,
  isProcessing,
  isMobile,
  groupChat,
  handleSubmitUserOnly,
  handleTypingChange,
}: Readonly<ChatPromptInputProps>): React.JSX.Element {
  return (
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
      autoFocus={!isMobile}
      {...(groupChat === undefined
        ? {}
        : {
            conversationId: groupChat.conversationId,
            currentUserPrivilege: groupChat.currentUserPrivilege as
              | 'read'
              | 'write'
              | 'admin'
              | 'owner',
          })}
      {...(groupChat &&
        groupChat.members.length > 1 && {
          isGroupChat: true,
          onSubmitUserOnly: handleSubmitUserOnly,
        })}
      {...(groupChat?.ws !== undefined && {
        onTypingChange: handleTypingChange,
      })}
    />
  );
}

function buildMessageListGroupProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MessageList>> {
  if (!groupChat || groupChat.members.length <= 1) return {};
  return {
    isGroupChat: true,
    currentUserId: groupChat.currentUserId,
    members: groupChat.members,
  };
}

interface ChatMainContentProps {
  readonly messages: Message[];
  readonly streamingMessageId: string | null;
  readonly errorMessageId: string | undefined;
  readonly modelName: string;
  readonly onShare: (messageId: string) => void;
  readonly isDecrypting: boolean | undefined;
  readonly groupChat: GroupChatProps | undefined;
  readonly virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}

function ChatMainContent({
  messages,
  streamingMessageId,
  errorMessageId,
  modelName,
  onShare,
  isDecrypting,
  groupChat,
  virtuosoRef,
}: Readonly<ChatMainContentProps>): React.JSX.Element {
  const showDecrypting = messages.length === 0 && isDecrypting;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {!showDecrypting && (
        <MessageList
          ref={virtuosoRef}
          messages={messages}
          streamingMessageId={streamingMessageId}
          errorMessageId={errorMessageId}
          modelName={modelName}
          onShare={onShare}
          {...buildMessageListGroupProps(groupChat)}
        />
      )}
      {showDecrypting && (
        <div className="flex flex-1 items-center justify-center" data-testid="decrypting-indicator">
          <div className="flex flex-col items-center gap-3">
            <Lock className="text-muted-foreground h-8 w-8" />
            <span className="text-muted-foreground text-sm">Decrypting your conversation...</span>
          </div>
        </div>
      )}
      {groupChat?.typingUserIds !== undefined && groupChat.typingUserIds.size > 0 && (
        <TypingIndicator typingUserIds={groupChat.typingUserIds} members={groupChat.members} />
      )}
    </div>
  );
}

function getContentAreaStyle(
  isMobile: boolean,
  inputHeight: number
): React.CSSProperties | undefined {
  if (isMobile && inputHeight > 0) return { marginBottom: inputHeight };
  return undefined;
}

export function ChatLayout({
  title,
  messages,
  streamingMessageId,
  inputValue,
  onInputChange,
  onSubmit,
  onSubmitUserOnly,
  inputDisabled,
  isProcessing,
  historyCharacters,
  isAuthenticated,
  promptInputRef: externalPromptInputRef,
  errorMessageId,
  isDecrypting,
  conversationId,
  groupChat,
}: ChatLayoutProps): React.JSX.Element {
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();
  const { bottom: keyboardOffset, isKeyboardVisible } = useKeyboardOffset();
  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();
  const { data: modelsData } = useModels();
  const models = React.useMemo(() => modelsData?.models ?? [], [modelsData?.models]);
  const tierInfo = useTierInfo();
  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);
  const queryClient = useQueryClient();

  const internalPromptInputRef = React.useRef<PromptInputRef>(null);
  const virtuosoRef = React.useRef<VirtuosoHandle>(null);
  const inputContainerRef = React.useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = React.useState(0);

  const {
    signupModalOpen,
    paymentModalOpen,
    premiumModelName,
    setSignupModalOpen,
    setPaymentModalOpen,
    addMemberModalOpen,
    budgetSettingsModalOpen,
    inviteLinkModalOpen,
    shareMessageModalOpen,
    shareMessageId,
    toggleMemberSidebar,
    mobileMemberSidebarOpen,
    setMobileMemberSidebarOpen,
    closeAddMemberModal,
    openAddMemberModal,
    closeBudgetSettingsModal,
    openBudgetSettingsModal,
    closeInviteLinkModal,
    openInviteLinkModal,
    openShareMessageModal,
    closeShareMessageModal,
  } = useUIModalsStore();

  const derived = resolveChatLayoutDerivedState({
    modelsData,
    tierInfo: tierInfo ?? undefined,
    shareMessageId,
    messages,
  });
  const { premiumIds, canAccessPremium, sharedMessageContent } = derived;
  const promptInputRef = externalPromptInputRef ?? internalPromptInputRef;

  const handleSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      onSubmit(fundingSource);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      });
    },
    [onSubmit]
  );

  const handleSubmitUserOnly = React.useCallback((): void => {
    if (onSubmitUserOnly) {
      onSubmitUserOnly();
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      });
    }
  }, [onSubmitUserOnly]);

  useInputFocusManagement(inputDisabled, isMobile, promptInputRef);
  useStreamScrollEffect(streamingMessageId, messages.length, virtuosoRef);

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

  // Close document panel when navigating to a different conversation
  React.useEffect(() => {
    useDocumentStore.getState().closePanel();
  }, [conversationId]);

  const handleFacepileClick = React.useCallback((): void => {
    if (isMobile) {
      setMobileMemberSidebarOpen(!mobileMemberSidebarOpen);
    } else {
      toggleMemberSidebar();
    }
  }, [isMobile, mobileMemberSidebarOpen, setMobileMemberSidebarOpen, toggleMemberSidebar]);

  const handleShareMessage = React.useCallback(
    (messageId: string): void => {
      openShareMessageModal(messageId);
    },
    [openShareMessageModal]
  );

  const handleTypingChange = React.useCallback(
    (isTyping: boolean): void => {
      if (!groupChat?.ws?.connected || !groupChat.currentUserId) return;
      const eventType = isTyping ? 'typing:start' : 'typing:stop';
      groupChat.ws.send(
        createEvent(eventType, {
          conversationId: groupChat.conversationId,
          userId: groupChat.currentUserId,
        })
      );
    },
    [groupChat]
  );

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
          {...buildChatHeaderGroupProps(groupChat, handleFacepileClick)}
        />
      </div>
      <div
        className="flex flex-1 overflow-hidden"
        style={getContentAreaStyle(isMobile, inputHeight)}
      >
        <ChatMainContent
          messages={messages}
          streamingMessageId={streamingMessageId}
          errorMessageId={errorMessageId}
          modelName={selectedModelName}
          onShare={handleShareMessage}
          isDecrypting={isDecrypting}
          groupChat={groupChat}
          virtuosoRef={virtuosoRef}
        />
        <DocumentPanel />
        {conversationId !== undefined && (
          <MemberSidebar
            key={conversationId}
            conversationId={conversationId}
            {...buildMemberSidebarProps(groupChat)}
            onBudgetSettingsClick={openBudgetSettingsModal}
            onAddMember={openAddMemberModal}
            onInviteLink={openInviteLinkModal}
          />
        )}
      </div>
      <div
        ref={inputContainerRef}
        data-chat-input
        className="bg-background flex-shrink-0 border-t p-4"
        style={inputStyle}
      >
        <div className="mx-auto w-full max-w-3xl">
          <ChatPromptInput
            promptInputRef={promptInputRef}
            inputValue={inputValue}
            onInputChange={onInputChange}
            handleSubmit={handleSubmit}
            historyCharacters={historyCharacters}
            inputDisabled={inputDisabled}
            isProcessing={isProcessing}
            isMobile={isMobile}
            groupChat={groupChat}
            handleSubmitUserOnly={handleSubmitUserOnly}
            handleTypingChange={handleTypingChange}
          />
        </div>
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
      {groupChat && (
        <GroupChatModals
          groupChat={groupChat}
          addMemberModalOpen={addMemberModalOpen}
          closeAddMemberModal={closeAddMemberModal}
          budgetSettingsModalOpen={budgetSettingsModalOpen}
          closeBudgetSettingsModal={closeBudgetSettingsModal}
          inviteLinkModalOpen={inviteLinkModalOpen}
          closeInviteLinkModal={closeInviteLinkModal}
        />
      )}
      <ShareMessageModal
        open={shareMessageModalOpen}
        onOpenChange={(open) => {
          if (!open) closeShareMessageModal();
        }}
        messageId={shareMessageId}
        messageContent={sharedMessageContent}
      />
    </div>
  );
}
