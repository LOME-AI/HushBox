import * as React from 'react';
import { Lock } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { MessageList, type MessageListHandle } from '@/components/chat/message/message-list';
import { TypingIndicator } from '@/components/chat/indicators/typing-indicator';
import { groupSenderMembers } from '@/hooks/chat/conversation-identity';
import { useSenderIdentityPending } from '@/hooks/chat/use-sender-identity-pending';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { Message } from '@/lib/api/api';
import type { MemberPrivilege } from '@hushbox/shared';
import type { BranchSummary } from '@/lib/chat/branch-summary';

function buildMessageListGroupProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MessageList>> {
  if (!groupChat) return {};
  const members = groupSenderMembers(groupChat.members, groupChat.links);
  if (members === undefined) return {};
  return {
    isGroupChat: true,
    currentUserId: groupChat.currentUserId,
    members,
    links: groupChat.links,
  };
}

interface ChatMainContentProps {
  readonly messages: Message[];
  readonly streamingMessageIds: Set<string>;
  readonly persistingMessageIds: Set<string> | undefined;
  readonly errorMessageId: string | undefined;
  readonly modelName: string;
  readonly onShare: (messageId: string) => void;
  readonly onRegenerate: ((messageId: string) => void) | undefined;
  readonly onEdit: ((messageId: string, content: string) => void) | undefined;
  readonly onFork: ((messageId: string) => void) | undefined;
  readonly isDecrypting: boolean | undefined;
  readonly groupChat: GroupChatProps | undefined;
  readonly virtuosoRef: React.RefObject<MessageListHandle | null>;
  readonly isAuthenticated: boolean;
  readonly isLinkGuest: boolean;
  readonly isMessageLink?: boolean | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly conversationId: string | undefined;
  readonly activeForkId: string | null | undefined;
  readonly messagesReady: boolean | undefined;
  readonly branches?: readonly BranchSummary[] | undefined;
  readonly onOpenBranches?: (() => void) | undefined;
  readonly threadHeader: React.ReactNode | undefined;
  readonly threadFooter: React.ReactNode | undefined;
}

function buildOptionalCallbackProps(
  props: Pick<ChatMainContentProps, 'onRegenerate' | 'onEdit' | 'onFork'>
): Partial<React.ComponentProps<typeof MessageList>> {
  return {
    ...(props.onRegenerate !== undefined && { onRegenerate: props.onRegenerate }),
    ...(props.onEdit !== undefined && { onEdit: props.onEdit }),
    ...(props.onFork !== undefined && { onFork: props.onFork }),
  };
}

function DecryptingPlaceholder({ shown }: Readonly<{ shown: boolean }>): React.JSX.Element | null {
  if (!shown) return null;
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      data-testid={TEST_IDS.sharedConversationLoading}
    >
      <div className="flex flex-col items-center gap-3">
        <Lock className="text-muted-foreground h-8 w-8" />
        <span className="text-muted-foreground text-sm">Decrypting your conversation...</span>
      </div>
    </div>
  );
}

/**
 * Whether the decrypting placeholder covers the thread area. The list stays hidden while it
 * places the thread and waits for the markdown renderer, so the placeholder stays until the list
 * reports the thread drawn, rather than leaving an empty area.
 */
function coversThreadArea(
  messageCount: number,
  isDecrypting: boolean | undefined,
  threadRevealed: boolean
): boolean {
  if (messageCount === 0) return isDecrypting === true;
  return !threadRevealed;
}

interface ThreadCover {
  readonly listMounted: boolean;
  readonly showPlaceholder: boolean;
  readonly onRevealedChange: (revealed: boolean) => void;
}

/**
 * The longest an otherwise ready thread waits for its senders to be named: the reads have no
 * client timeout, and offline they pause before their first attempt. Not shared with the list's
 * font wait, which bounds a different wait.
 */
const SENDER_IDENTITY_WAIT_MS = 2000;

/**
 * Calls `release` once `holding` has stayed true for the wait, counted afresh each time it
 * turns true.
 */
function useHoldCap(holding: boolean, release: () => void): void {
  React.useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(release, SENDER_IDENTITY_WAIT_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [holding, release]);
}

/**
 * Whether the list is mounted and whether the placeholder covers the thread. A group's list
 * mounts only once its senders can be named, so its labels draw in the first revealed frame, or
 * once the hold has kept an otherwise ready thread hidden for its wait, after which the labels
 * draw whenever the reads land. The hold covers a list not yet opened in this conversation: one
 * already showing stays mounted when a failed read is asked again or the member count lands late.
 */
function useThreadCover(
  conversationId: string | undefined,
  messageCount: number,
  isDecrypting: boolean | undefined
): ThreadCover {
  const senderIdentityPending = useSenderIdentityPending(conversationId);
  const [openedIn, setOpenedIn] = React.useState<string | undefined>();
  const otherwiseReady = !(messageCount === 0 && isDecrypting === true);
  const listHeld = senderIdentityPending && openedIn !== conversationId;
  const listMounted = otherwiseReady && !listHeld;
  if (listMounted && openedIn !== conversationId) setOpenedIn(conversationId);
  const open = React.useCallback((): void => {
    setOpenedIn(conversationId);
  }, [conversationId]);
  useHoldCap(otherwiseReady && listHeld, open);
  const [threadRevealed, setThreadRevealed] = React.useState(false);
  return {
    listMounted,
    showPlaceholder: listHeld || coversThreadArea(messageCount, isDecrypting, threadRevealed),
    onRevealedChange: setThreadRevealed,
  };
}

function ChatMainContentInner({
  messages,
  streamingMessageIds,
  persistingMessageIds,
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
  isMessageLink,
  callerPrivilege,
  conversationId,
  activeForkId,
  messagesReady,
  branches,
  onOpenBranches,
  threadHeader,
  threadFooter,
}: Readonly<ChatMainContentProps>): React.JSX.Element {
  const { listMounted, showPlaceholder, onRevealedChange } = useThreadCover(
    conversationId,
    messages.length,
    isDecrypting
  );
  const typingMembers = groupChat?.typingUserIds;
  const showTyping = typingMembers !== undefined && typingMembers.size > 0;

  // Stabilize the props derived from primitives so the memoized MessageList
  // sees identical references across re-renders that don't change its inputs.
  const conversationKey = `${conversationId ?? 'init'}-${activeForkId ?? 'main'}`;
  const optionalCallbackProps = React.useMemo(
    () => buildOptionalCallbackProps({ onRegenerate, onEdit, onFork }),
    [onRegenerate, onEdit, onFork]
  );
  const groupProps = React.useMemo(() => buildMessageListGroupProps(groupChat), [groupChat]);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {listMounted && (
        <MessageList
          ref={virtuosoRef}
          messages={messages}
          streamingMessageIds={streamingMessageIds}
          persistingMessageIds={persistingMessageIds}
          errorMessageId={errorMessageId}
          modelName={modelName}
          onShare={onShare}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest}
          isMessageLink={isMessageLink}
          callerPrivilege={callerPrivilege}
          messagesReady={messagesReady}
          conversationKey={conversationKey}
          branches={branches}
          activeForkId={activeForkId}
          onOpenBranches={onOpenBranches}
          threadHeader={threadHeader}
          threadFooter={threadFooter}
          onRevealedChange={onRevealedChange}
          {...optionalCallbackProps}
          {...groupProps}
        />
      )}
      {showTyping && (
        <TypingIndicator typingUserIds={typingMembers} members={groupChat?.members ?? []} />
      )}
      <DecryptingPlaceholder shown={showPlaceholder} />
    </div>
  );
}

// Memoized so a prompt-input keystroke (which re-renders the chat layout but
// leaves these props referentially stable) does not re-render the virtualized
// MessageList. Requires the parent to pass stable callback references; see
// authenticated-chat-page.tsx.
export const ChatMainContent = React.memo(ChatMainContentInner);
