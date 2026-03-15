import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { VirtuosoHandle } from 'react-virtuoso';
import { ChatHeader } from '@/components/chat/chat-header';
import { ComparisonBar } from '@/components/chat/comparison-bar';
import { ForkTabs } from '@/components/chat/fork-tabs';
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
import { useModelStore, getPrimaryModel, type SelectedModelEntry } from '@/stores/model';
import { useSearchStore } from '@/stores/search';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useSelectedModelCapabilities } from '@/hooks/use-selected-model-capabilities';
import { billingKeys } from '@/hooks/billing';
import { TypingIndicator } from '@/components/chat/typing-indicator';
import { Lock } from 'lucide-react';
import { createEvent } from '@hushbox/realtime/events';
import type { FundingSource, MemberPrivilege } from '@hushbox/shared';
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
  readonly currentUserPrivilege: MemberPrivilege;
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
  readonly streamingMessageIds: Set<string>;
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
  readonly callerPrivilege?: MemberPrivilege | undefined;
  readonly forks?:
    | {
        id: string;
        conversationId: string;
        name: string;
        tipMessageId: string | null;
        createdAt: string;
      }[]
    | undefined;
  readonly activeForkId?: string | null | undefined;
  readonly onForkSelect?: ((forkId: string) => void) | undefined;
  readonly onForkRename?: ((forkId: string, currentName: string) => void) | undefined;
  readonly onForkDelete?: ((forkId: string) => void) | undefined;
  readonly onRegenerate?: ((messageId: string) => void) | undefined;
  readonly onEdit?: ((messageId: string, content: string) => void) | undefined;
  readonly onFork?: ((messageId: string) => void) | undefined;
  readonly isLinkGuest?: boolean | undefined;
  readonly isEditing?: boolean | undefined;
  readonly onCancelEdit?: (() => void) | undefined;
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
  plaintextTitle: string;
  addMemberModalOpen: boolean;
  closeAddMemberModal: () => void;
  budgetSettingsModalOpen: boolean;
  closeBudgetSettingsModal: () => void;
  inviteLinkModalOpen: boolean;
  closeInviteLinkModal: () => void;
}

function GroupChatModals({
  groupChat,
  plaintextTitle,
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
        currentEpochNumber={groupChat.currentEpochNumber}
        plaintextTitle={plaintextTitle}
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
  streamingMessageIds: Set<string>,
  messagesLength: number,
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
): void {
  const previousWasStreamingRef = React.useRef(false);

  React.useEffect(() => {
    const wasStreaming = previousWasStreamingRef.current;
    const isNowStreaming = streamingMessageIds.size > 0;
    previousWasStreamingRef.current = isNowStreaming;

    const isFirstMessage = messagesLength <= 2;

    if (!wasStreaming && isNowStreaming && isFirstMessage) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      });
    }
  }, [streamingMessageIds, messagesLength, virtuosoRef]);
}

interface ChatLayoutDerivedInput {
  readonly premiumIds: Set<string>;
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
    premiumIds: input.premiumIds,
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
  readonly conversationId: string | undefined;
  readonly groupChat: GroupChatProps | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly handleSubmitUserOnly: () => void;
  readonly handleTypingChange: (isTyping: boolean) => void;
  readonly webSearchEnabled: boolean;
  readonly modelSupportsSearch: boolean;
  readonly isAuthenticated: boolean;
  readonly onToggleWebSearch: () => void;
  readonly isEditing?: boolean | undefined;
  readonly onCancelEdit?: (() => void) | undefined;
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

interface BuildPromptInputPropsInput {
  readonly groupChat: GroupChatProps | undefined;
  readonly conversationId: string | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly isEditing: boolean | undefined;
  readonly onCancelEdit: (() => void) | undefined;
  readonly handleSubmitUserOnly: () => void;
  readonly handleTypingChange: (isTyping: boolean) => void;
}

function resolveConversationProps(
  groupChat: GroupChatProps | undefined,
  conversationId: string | undefined,
  callerPrivilege: MemberPrivilege | undefined
): Partial<React.ComponentProps<typeof PromptInput>> {
  if (groupChat !== undefined) {
    return {
      conversationId: groupChat.conversationId,
      currentUserPrivilege: groupChat.currentUserPrivilege,
    };
  }
  const result: Partial<React.ComponentProps<typeof PromptInput>> = {};
  if (conversationId !== undefined) result.conversationId = conversationId;
  if (callerPrivilege !== undefined) result.currentUserPrivilege = callerPrivilege;
  return result;
}

function resolveGroupChatProps(
  groupChat: GroupChatProps | undefined,
  handleSubmitUserOnly: () => void,
  handleTypingChange: (isTyping: boolean) => void
): Partial<React.ComponentProps<typeof PromptInput>> {
  if (!groupChat) return {};
  const result: Partial<React.ComponentProps<typeof PromptInput>> = {};
  if (groupChat.members.length > 1 || groupChat.links.length > 0) {
    result.isGroupChat = true;
    result.onSubmitUserOnly = handleSubmitUserOnly;
  }
  if (groupChat.ws !== undefined) {
    result.onTypingChange = handleTypingChange;
  }
  return result;
}

function buildPromptInputProps(
  input: BuildPromptInputPropsInput
): Partial<React.ComponentProps<typeof PromptInput>> {
  return {
    ...resolveConversationProps(input.groupChat, input.conversationId, input.callerPrivilege),
    ...resolveGroupChatProps(input.groupChat, input.handleSubmitUserOnly, input.handleTypingChange),
    ...(input.isEditing !== undefined && { isEditing: input.isEditing }),
    ...(input.onCancelEdit !== undefined && { onCancelEdit: input.onCancelEdit }),
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
  conversationId,
  groupChat,
  callerPrivilege,
  handleSubmitUserOnly,
  handleTypingChange,
  webSearchEnabled,
  modelSupportsSearch,
  isAuthenticated,
  onToggleWebSearch,
  isEditing,
  onCancelEdit,
}: Readonly<ChatPromptInputProps>): React.JSX.Element {
  const spreadProps = buildPromptInputProps({
    groupChat,
    conversationId,
    callerPrivilege,
    isEditing,
    onCancelEdit,
    handleSubmitUserOnly,
    handleTypingChange,
  });

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
      webSearchEnabled={webSearchEnabled}
      modelSupportsSearch={modelSupportsSearch}
      isAuthenticated={isAuthenticated}
      onToggleWebSearch={onToggleWebSearch}
      {...spreadProps}
    />
  );
}

function buildMessageListGroupProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MessageList>> {
  if (!groupChat || (groupChat.members.length <= 1 && groupChat.links.length === 0)) {
    return {};
  }
  return {
    isGroupChat: true,
    currentUserId: groupChat.currentUserId,
    members: groupChat.members,
    links: groupChat.links,
  };
}

interface ChatMainContentProps {
  readonly messages: Message[];
  readonly streamingMessageIds: Set<string>;
  readonly errorMessageId: string | undefined;
  readonly modelName: string;
  readonly onShare: (messageId: string) => void;
  readonly onRegenerate: ((messageId: string) => void) | undefined;
  readonly onEdit: ((messageId: string, content: string) => void) | undefined;
  readonly onFork: ((messageId: string) => void) | undefined;
  readonly isDecrypting: boolean | undefined;
  readonly groupChat: GroupChatProps | undefined;
  readonly virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  readonly isAuthenticated: boolean;
  readonly isLinkGuest: boolean;
  readonly callerPrivilege: MemberPrivilege | undefined;
}

function ChatMainContent({
  messages,
  streamingMessageIds,
  errorMessageId,
  modelName,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  isDecrypting,
  groupChat,
  virtuosoRef,
  isAuthenticated,
  isLinkGuest,
  callerPrivilege,
}: Readonly<ChatMainContentProps>): React.JSX.Element {
  const showDecrypting = messages.length === 0 && isDecrypting;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {!showDecrypting && (
        <MessageList
          ref={virtuosoRef}
          messages={messages}
          streamingMessageIds={streamingMessageIds}
          errorMessageId={errorMessageId}
          modelName={modelName}
          onShare={onShare}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest}
          callerPrivilege={callerPrivilege}
          {...(onRegenerate !== undefined && { onRegenerate })}
          {...(onEdit !== undefined && { onEdit })}
          {...(onFork !== undefined && { onFork })}
          {...buildMessageListGroupProps(groupChat)}
        />
      )}
      {showDecrypting && (
        <div className="flex flex-1 items-center justify-center" data-testid="shared-conversation-loading">
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

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for noop fallback
const NOOP = (): void => {};

interface ForkTabsResolvedProps {
  forks: NonNullable<ChatLayoutProps['forks']>;
  activeForkId: string | null;
  onForkSelect: (forkId: string) => void;
  onRename: (forkId: string, currentName: string) => void;
  onDelete: (forkId: string) => void;
}

interface ForkTabsInput {
  forks: ChatLayoutProps['forks'];
  activeForkId: ChatLayoutProps['activeForkId'];
  onForkSelect: ChatLayoutProps['onForkSelect'];
  onForkRename: ChatLayoutProps['onForkRename'];
  onForkDelete: ChatLayoutProps['onForkDelete'];
}

function resolveForkTabsProps(input: ForkTabsInput): ForkTabsResolvedProps {
  return {
    forks: input.forks ?? [],
    activeForkId: input.activeForkId ?? null,
    onForkSelect: input.onForkSelect ?? NOOP,
    onRename: input.onForkRename ?? NOOP,
    onDelete: input.onForkDelete ?? NOOP,
  };
}

function useInputHeightObserver(
  isMobile: boolean,
  inputContainerRef: React.RefObject<HTMLDivElement | null>
): number {
  const [inputHeight, setInputHeight] = React.useState(0);

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
  }, [isMobile, inputContainerRef]);

  return inputHeight;
}

function useSubmitUserOnly(
  onSubmitUserOnly: (() => void) | undefined,
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
): () => void {
  return React.useCallback((): void => {
    if (onSubmitUserOnly) {
      onSubmitUserOnly();
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      });
    }
  }, [onSubmitUserOnly, virtuosoRef]);
}

function useTypingBroadcast(groupChat: GroupChatProps | undefined): (isTyping: boolean) => void {
  return React.useCallback(
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
}

interface LayoutModals {
  signupModalOpen: boolean;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;
  setSignupModalOpen: (open: boolean) => void;
  setPaymentModalOpen: (open: boolean) => void;
  addMemberModalOpen: boolean;
  budgetSettingsModalOpen: boolean;
  inviteLinkModalOpen: boolean;
  shareMessageModalOpen: boolean;
  shareMessageId: string | null;
  toggleMemberSidebar: () => void;
  mobileMemberSidebarOpen: boolean;
  setMobileMemberSidebarOpen: (open: boolean) => void;
  closeAddMemberModal: () => void;
  openAddMemberModal: () => void;
  closeBudgetSettingsModal: () => void;
  openBudgetSettingsModal: () => void;
  closeInviteLinkModal: () => void;
  openInviteLinkModal: () => void;
  openShareMessageModal: (messageId: string) => void;
  closeShareMessageModal: () => void;
}

function useLayoutModals(): LayoutModals {
  return useUIModalsStore();
}

interface ChatLayoutModalsProps {
  readonly signupModalOpen: boolean;
  readonly setSignupModalOpen: (open: boolean) => void;
  readonly paymentModalOpen: boolean;
  readonly setPaymentModalOpen: (open: boolean) => void;
  readonly premiumModelName: string | undefined;
  readonly shareMessageModalOpen: boolean;
  readonly closeShareMessageModal: () => void;
  readonly shareMessageId: string | null;
  readonly sharedMessageContent: string | null;
  readonly groupChat: GroupChatProps | undefined;
  readonly title: string | undefined;
  readonly addMemberModalOpen: boolean;
  readonly closeAddMemberModal: () => void;
  readonly budgetSettingsModalOpen: boolean;
  readonly closeBudgetSettingsModal: () => void;
  readonly inviteLinkModalOpen: boolean;
  readonly closeInviteLinkModal: () => void;
}

function ChatLayoutModals({
  signupModalOpen,
  setSignupModalOpen,
  paymentModalOpen,
  setPaymentModalOpen,
  premiumModelName,
  shareMessageModalOpen,
  closeShareMessageModal,
  shareMessageId,
  sharedMessageContent,
  groupChat,
  title,
  addMemberModalOpen,
  closeAddMemberModal,
  budgetSettingsModalOpen,
  closeBudgetSettingsModal,
  inviteLinkModalOpen,
  closeInviteLinkModal,
}: Readonly<ChatLayoutModalsProps>): React.JSX.Element {
  const queryClient = useQueryClient();

  return (
    <>
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
          plaintextTitle={title ?? ''}
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
    </>
  );
}

export function ChatLayout({
  title,
  messages,
  streamingMessageIds,
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
  callerPrivilege,
  forks,
  activeForkId,
  onForkSelect,
  onForkRename,
  onForkDelete,
  onRegenerate,
  onEdit,
  onFork,
  isLinkGuest,
  isEditing,
  onCancelEdit,
}: ChatLayoutProps): React.JSX.Element {
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();
  const { bottom: keyboardOffset, isKeyboardVisible } = useKeyboardOffset();
  const { selectedModels } = useModelStore();
  const { webSearchEnabled, toggleWebSearch } = useSearchStore();
  const { models, premiumIds: modelPremiumIds, supportsSearch } = useSelectedModelCapabilities();
  const handleModelSelect = React.useCallback((entries: SelectedModelEntry[]): void => {
    useModelStore.setState({ selectedModels: entries });
  }, []);
  const handleRemoveModel = React.useCallback((modelId: string): void => {
    useModelStore.getState().removeModel(modelId);
  }, []);
  const tierInfo = useTierInfo();
  const tierInfoOrUndefined = tierInfo ?? undefined;
  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  const internalPromptInputRef = React.useRef<PromptInputRef>(null);
  const virtuosoRef = React.useRef<VirtuosoHandle>(null);
  const inputContainerRef = React.useRef<HTMLDivElement>(null);
  const inputHeight = useInputHeightObserver(isMobile, inputContainerRef);
  const promptInputRef = externalPromptInputRef ?? internalPromptInputRef;

  const modals = useLayoutModals();
  const {
    shareMessageId,
    toggleMemberSidebar,
    mobileMemberSidebarOpen,
    setMobileMemberSidebarOpen,
    openAddMemberModal,
    openBudgetSettingsModal,
    openInviteLinkModal,
    openShareMessageModal,
  } = modals;

  const derived = resolveChatLayoutDerivedState({
    premiumIds: modelPremiumIds,
    tierInfo: tierInfoOrUndefined,
    shareMessageId,
    messages,
  });
  const { premiumIds, canAccessPremium, sharedMessageContent } = derived;

  const handleSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      onSubmit(fundingSource);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      });
    },
    [onSubmit]
  );

  const handleSubmitUserOnly = useSubmitUserOnly(onSubmitUserOnly, virtuosoRef);

  useInputFocusManagement(inputDisabled, isMobile, promptInputRef);
  useStreamScrollEffect(streamingMessageIds, messages.length, virtuosoRef);

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

  const handleTypingChange = useTypingBroadcast(groupChat);

  const inputStyle = getMobileInputStyle({ isMobile, keyboardOffset, isKeyboardVisible });
  const wsConnected = groupChat?.ws?.connected === true ? 'true' : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ height: `${String(viewportHeight)}px` }}
      data-ws-connected={wsConnected}
    >
      <div data-chat-header>
        <ChatHeader
          models={models}
          selectedModels={selectedModels}
          onModelSelect={handleModelSelect}
          title={title}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          onPremiumClick={handlePremiumClick}
          {...buildChatHeaderGroupProps(groupChat, handleFacepileClick)}
        />
      </div>
      <ComparisonBar
        models={models}
        selectedModels={selectedModels}
        onRemoveModel={handleRemoveModel}
      />
      <ForkTabs
        {...resolveForkTabsProps({ forks, activeForkId, onForkSelect, onForkRename, onForkDelete })}
      />
      <div
        className="flex flex-1 overflow-hidden"
        style={getContentAreaStyle(isMobile, inputHeight)}
      >
        <ChatMainContent
          messages={messages}
          streamingMessageIds={streamingMessageIds}
          errorMessageId={errorMessageId}
          modelName={getPrimaryModel(selectedModels).id}
          onShare={handleShareMessage}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onFork={onFork}
          isDecrypting={isDecrypting}
          groupChat={groupChat}
          virtuosoRef={virtuosoRef}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest ?? false}
          callerPrivilege={callerPrivilege}
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
            conversationId={conversationId}
            groupChat={groupChat}
            callerPrivilege={callerPrivilege}
            handleSubmitUserOnly={handleSubmitUserOnly}
            handleTypingChange={handleTypingChange}
            webSearchEnabled={webSearchEnabled}
            modelSupportsSearch={supportsSearch}
            isAuthenticated={isAuthenticated}
            onToggleWebSearch={toggleWebSearch}
            isEditing={isEditing}
            onCancelEdit={onCancelEdit}
          />
        </div>
      </div>
      <ChatLayoutModals
        signupModalOpen={modals.signupModalOpen}
        setSignupModalOpen={modals.setSignupModalOpen}
        paymentModalOpen={modals.paymentModalOpen}
        setPaymentModalOpen={modals.setPaymentModalOpen}
        premiumModelName={modals.premiumModelName}
        shareMessageModalOpen={modals.shareMessageModalOpen}
        closeShareMessageModal={modals.closeShareMessageModal}
        shareMessageId={modals.shareMessageId}
        sharedMessageContent={sharedMessageContent}
        groupChat={groupChat}
        title={title}
        addMemberModalOpen={modals.addMemberModalOpen}
        closeAddMemberModal={modals.closeAddMemberModal}
        budgetSettingsModalOpen={modals.budgetSettingsModalOpen}
        closeBudgetSettingsModal={modals.closeBudgetSettingsModal}
        inviteLinkModalOpen={modals.inviteLinkModalOpen}
        closeInviteLinkModal={modals.closeInviteLinkModal}
      />
    </div>
  );
}
