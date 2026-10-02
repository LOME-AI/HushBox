import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile, useVisualViewportHeight } from '@hushbox/ui';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { ChatHeader } from '@/components/chat/layout/chat-header';
import { BranchSwitcher } from '@/components/chat/layout/branch-switcher';
import { ModelSelectorButton } from '@/components/chat/model-selector/model-selector-button';
import { type MessageListHandle } from '@/components/chat/message/message-list';
import { MemberSidebar } from '@/components/chat/member/member-sidebar';
import {
  ChatPromptInput,
  buildChatHeaderGroupProps,
} from '@/components/chat/input/chat-prompt-input';
import { QueuedMessages } from '@/components/chat/input/queued-messages';
import { promptPredictor } from '@/lib/prediction/prompt-predictor';
import { branchSummaries } from '@/lib/chat/branch-summary';
import { ChatMainContent } from '@/components/chat/layout/chat-main-content';
import { ChatLayoutModals } from '@/components/chat/layout/chat-layout-modals';
import {
  getContentAreaStyle,
  getMobileInputStyle,
  getWebSocketAttributes,
  buildMemberSidebarProps,
  resolveChatLayoutDerivedState,
  resolveBranchSwitcherHandlers,
} from '@/components/chat/layout/chat-layout-helpers';
import {
  useInputFocusManagement,
  useInputHeightObserver,
  useStreamScrollEffect,
  useSubmitUserOnly,
  useTypingBroadcast,
} from '@/components/chat/layout/chat-layout-hooks';
import { useKeyboardOffset } from '@/hooks/ui/use-keyboard-offset';
import { usePremiumModelClick } from '@/hooks/models/use-premium-model-click';
import { useModelStore, getPrimaryModel, type SelectedModelEntry } from '@/stores/model';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useSelectedModelCapabilities } from '@/hooks/models/use-selected-model-capabilities';
import { useResolveDefaultModel } from '@/hooks/models/use-resolve-default-model';
import { useDocumentStore } from '@/stores/document';
import type { FundingSource, MemberPrivilege, ChatModality, RefusalCode } from '@hushbox/shared';
import type { ChatSearchProps } from '@/components/chat/input/prompt-input';
import type { PickerConversationContext } from '@/components/chat/model-selector/model-selector-types';
import type { GroupChatProps, PromptInputRef } from '@/components/chat/message/types';
import type { Message } from '@/lib/api/api';
import type { QueuedMessage } from '@/stores/chat/message-queue';

export type { GroupChatProps, PromptInputRef } from '@/components/chat/message/types';

// The document panel pulls the markdown/diagram stack (streamdown → shiki,
// mermaid, katex). Lazy-load it so a text-only chat never drags those into the
// boot graph; it stays empty until a document is opened, so no fallback is
// needed while the chunk resolves.
const DocumentPanel = React.lazy(async () => {
  const m = await import('@/components/document-panel/document-panel');
  return { default: m.DocumentPanel };
});

export interface ChatLayoutProps {
  readonly title?: string | undefined;
  readonly messages: Message[];
  /** Every branch's stored messages, which the branch switcher summarises; `messages` holds only the open branch. */
  readonly branchMessages?: readonly Message[] | undefined;
  readonly streamingMessageIds: Set<string>;
  /** Server-side persistence-tracking set; see MessageList docs. */
  readonly persistingMessageIds?: Set<string> | undefined;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: (fundingSource: FundingSource) => void;
  readonly onSubmitUserOnly?: (() => void) | undefined;
  readonly inputDisabled: boolean;
  readonly isProcessing: boolean;
  /** Stops the active run (server settles + bills the partial). */
  readonly onStop?: (() => void) | undefined;
  /** Enqueue the composed text while a run streams (composer's `onQueue`). */
  readonly onQueue?: ((text: string) => void) | undefined;
  /** Number of already-queued messages (drives the composer's queue-full hint). */
  readonly queueCount?: number | undefined;
  /** Whether the queue is at capacity (disables the composer's queue action). */
  readonly queueFull?: boolean | undefined;
  /** Queued messages to render as pills above the composer, oldest first. */
  readonly queuedMessages?: QueuedMessage[] | undefined;
  /** Remove a queued message by id (pill cancel). */
  readonly onCancelQueued?: ((id: string) => void) | undefined;
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
  /** See MessageList docs — parent-derived signal that messages reflect final data. */
  readonly messagesReady?: boolean | undefined;
}

interface LayoutModals {
  signupModalOpen: boolean;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;
  refusalReason: RefusalCode | undefined;
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
  return useUIModalsStore(
    useShallow((s) => ({
      signupModalOpen: s.signupModalOpen,
      paymentModalOpen: s.paymentModalOpen,
      premiumModelName: s.premiumModelName,
      refusalReason: s.refusalReason,
      setSignupModalOpen: s.setSignupModalOpen,
      setPaymentModalOpen: s.setPaymentModalOpen,
      addMemberModalOpen: s.addMemberModalOpen,
      budgetSettingsModalOpen: s.budgetSettingsModalOpen,
      inviteLinkModalOpen: s.inviteLinkModalOpen,
      shareMessageModalOpen: s.shareMessageModalOpen,
      shareMessageId: s.shareMessageId,
      toggleMemberSidebar: s.toggleMemberSidebar,
      mobileMemberSidebarOpen: s.mobileMemberSidebarOpen,
      setMobileMemberSidebarOpen: s.setMobileMemberSidebarOpen,
      closeAddMemberModal: s.closeAddMemberModal,
      openAddMemberModal: s.openAddMemberModal,
      closeBudgetSettingsModal: s.closeBudgetSettingsModal,
      openBudgetSettingsModal: s.openBudgetSettingsModal,
      closeInviteLinkModal: s.closeInviteLinkModal,
      openInviteLinkModal: s.openInviteLinkModal,
      openShareMessageModal: s.openShareMessageModal,
      closeShareMessageModal: s.closeShareMessageModal,
    }))
  );
}

/** Queued-message pills, rendered above the composer. Null unless both the queue
 * data and its cancel handler are supplied (kept out of ChatLayout to hold its
 * cyclomatic complexity down). */
function renderQueuedPills(
  queuedMessages: QueuedMessage[] | undefined,
  onCancelQueued: ((id: string) => void) | undefined
): React.JSX.Element | null {
  if (queuedMessages === undefined || onCancelQueued === undefined) return null;
  return <QueuedMessages queued={queuedMessages} onCancel={onCancelQueued} className="mb-2" />;
}

/** The conversation the picker prices against — it names the payer. */
function buildFloorGroup(
  groupChat: GroupChatProps | undefined
): PickerConversationContext | undefined {
  if (groupChat === undefined) return undefined;
  return { conversationId: groupChat.conversationId };
}

export function ChatLayout({
  title,
  messages,
  branchMessages,
  streamingMessageIds,
  persistingMessageIds,
  inputValue,
  onInputChange,
  onSubmit,
  onSubmitUserOnly,
  inputDisabled,
  isProcessing,
  onStop,
  onQueue,
  queueCount,
  queueFull,
  queuedMessages,
  onCancelQueued,
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
  messagesReady,
}: ChatLayoutProps): React.JSX.Element {
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();
  const { bottom: keyboardOffset, isKeyboardVisible } = useKeyboardOffset();
  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const setActiveModality = useModelStore((state) => state.setActiveModality);
  // Absent only before the conversation exists, which the funding scope and the
  // share dialog both spell `null`.
  const conversationIdOrNull = conversationId ?? null;
  useResolveDefaultModel(activeModality, conversationIdOrNull);
  const webSearch = useWebSearch();
  const selectModality = React.useCallback(
    (modality: ChatModality): void => {
      setActiveModality(modality);
    },
    [setActiveModality]
  );
  const { models, premiumIds: modelPremiumIds } = useSelectedModelCapabilities();
  // Search is a text-mode feature. Omit searchProps entirely in image mode
  // so the toggle disappears at the structural level, not a render-time check.
  const searchProps: ChatSearchProps | undefined =
    activeModality === 'text'
      ? {
          webSearchEnabled: webSearch.active,
          canUseWebSearch: webSearch.canUse,
          onToggleWebSearch: webSearch.toggle,
        }
      : undefined;
  const handleModelSelect = React.useCallback((entries: SelectedModelEntry[]): void => {
    const { activeModality: current, setSelectedModels } = useModelStore.getState();
    setSelectedModels(current, entries);
  }, []);
  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  const internalPromptInputRef = React.useRef<PromptInputRef>(null);
  const virtuosoRef = React.useRef<MessageListHandle>(null);
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
    shareMessageId,
    messages,
  });
  const {
    premiumIds,
    sharedMessageContent,
    sharedMessageEpochNumber,
    sharedMessageWrappedContentKey,
    sharedMessageMediaItems,
    sharedMessageSenderId,
    sharedMessageReasoningTokens,
    sharedMessageReasoningEffort,
  } = derived;

  const handleSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      onSubmit(fundingSource);
      virtuosoRef.current?.resetScrollBreakaway();
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers scroll to next frame, not motion animation
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
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

  const [column, setColumn] = React.useState<HTMLDivElement | null>(null);
  const branches = React.useMemo(
    () => branchSummaries(branchMessages ?? messages, forks ?? []),
    [branchMessages, messages, forks]
  );

  const inputStyle = getMobileInputStyle({ isMobile, keyboardOffset, isKeyboardVisible });
  const { wsConnected, wsReady } = getWebSocketAttributes(groupChat?.ws);

  return (
    <div
      ref={setColumn}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ height: `${String(viewportHeight)}px` }}
      data-ws-connected={wsConnected}
      data-ws-ready={wsReady}
    >
      <div data-chat-header>
        <ChatHeader
          title={title}
          showNewChat={isAuthenticated && isLinkGuest !== true}
          isAuthenticated={isAuthenticated}
          {...buildChatHeaderGroupProps(groupChat, handleFacepileClick)}
          branchSwitcher={
            <BranchSwitcher
              branches={branches}
              boundary={column}
              {...resolveBranchSwitcherHandlers({
                activeForkId,
                onForkSelect,
                onForkRename,
                onForkDelete,
              })}
            />
          }
        />
      </div>
      <div
        className="flex flex-1 overflow-hidden"
        style={getContentAreaStyle(isMobile, inputHeight)}
      >
        <ChatMainContent
          messages={messages}
          streamingMessageIds={streamingMessageIds}
          persistingMessageIds={persistingMessageIds}
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
          conversationId={conversationId}
          activeForkId={activeForkId}
          messagesReady={messagesReady}
        />
        <React.Suspense fallback={null}>
          <DocumentPanel />
        </React.Suspense>
        {conversationId !== undefined && (
          <MemberSidebar
            conversationId={conversationId}
            {...buildMemberSidebarProps(groupChat)}
            {...(isLinkGuest && { onLeaveClick: undefined })}
            onBudgetSettingsClick={openBudgetSettingsModal}
            onAddMember={openAddMemberModal}
            onInviteLink={openInviteLinkModal}
          />
        )}
      </div>
      <div
        ref={inputContainerRef}
        data-chat-input
        data-chrome=""
        className="bg-background flex-shrink-0 border-t py-4"
        style={inputStyle}
      >
        <ChatColumn>
          {renderQueuedPills(queuedMessages, onCancelQueued)}
          <ChatPromptInput
            promptInputRef={promptInputRef}
            inputValue={inputValue}
            onInputChange={onInputChange}
            handleSubmit={handleSubmit}
            historyCharacters={historyCharacters}
            inputDisabled={inputDisabled}
            isProcessing={isProcessing}
            onStop={onStop}
            onQueue={onQueue}
            queueCount={queueCount}
            queueFull={queueFull}
            isMobile={isMobile}
            conversationId={conversationId}
            groupChat={groupChat}
            callerPrivilege={callerPrivilege}
            handleSubmitUserOnly={handleSubmitUserOnly}
            handleTypingChange={handleTypingChange}
            searchProps={searchProps}
            isAuthenticated={isAuthenticated}
            isEditing={isEditing}
            onCancelEdit={onCancelEdit}
            activeModality={activeModality}
            onSelectModality={selectModality}
            predictor={promptPredictor(0)}
            modelControl={
              <ModelSelectorButton
                models={models}
                selectedModels={selectedModels}
                onSelect={handleModelSelect}
                premiumIds={premiumIds}
                isAuthenticated={isAuthenticated}
                isLinkGuest={isLinkGuest ?? false}
                onPremiumClick={handlePremiumClick}
                activeModality={activeModality}
                floorGroup={buildFloorGroup(groupChat)}
              />
            }
          />
        </ChatColumn>
      </div>
      <ChatLayoutModals
        signupModalOpen={modals.signupModalOpen}
        setSignupModalOpen={modals.setSignupModalOpen}
        paymentModalOpen={modals.paymentModalOpen}
        setPaymentModalOpen={modals.setPaymentModalOpen}
        premiumModelName={modals.premiumModelName}
        refusalReason={modals.refusalReason}
        shareMessageModalOpen={modals.shareMessageModalOpen}
        closeShareMessageModal={modals.closeShareMessageModal}
        shareMessageId={modals.shareMessageId}
        shareMessageConversationId={conversationIdOrNull}
        sharedMessageContent={sharedMessageContent}
        sharedMessageEpochNumber={sharedMessageEpochNumber}
        sharedMessageWrappedContentKey={sharedMessageWrappedContentKey}
        sharedMessageMediaItems={sharedMessageMediaItems}
        sharedMessageSenderId={sharedMessageSenderId}
        sharedMessageReasoningTokens={sharedMessageReasoningTokens}
        sharedMessageReasoningEffort={sharedMessageReasoningEffort}
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
