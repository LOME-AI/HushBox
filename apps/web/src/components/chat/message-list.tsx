import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageItem } from './message-item';
import type { Message } from '@/lib/api';
import { groupConsecutiveMessages, type MessageGroup } from '@/lib/chat-sender';
import type { LinkInfo } from '@/lib/chat-sender';
import { isMultiModelResponse, canRegenerateMessage } from '@/lib/chat-regeneration';
import {
  resolveMessageActions,
  buildChatContext,
  type MessageContext,
} from '@/lib/message-actions';
import type { MemberPrivilege } from '@hushbox/shared';
import { env } from '@/lib/env';

interface MemberInfo {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

interface MessageListProps {
  messages: Message[];
  streamingMessageIds?: Set<string> | undefined;
  errorMessageId?: string | undefined;
  modelName?: string | undefined;
  onShare?: ((messageId: string) => void) | undefined;
  /** Called when user clicks regenerate (AI) or retry (user) */
  onRegenerate?: ((messageId: string) => void) | undefined;
  /** Called when user clicks edit on a user message */
  onEdit?: ((messageId: string, content: string) => void) | undefined;
  /** Called when user clicks fork on any message */
  onFork?: ((messageId: string) => void) | undefined;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for sender labels and alignment */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
  /** Shared links for resolving link guest sender names */
  links?: LinkInfo[];
  /** Whether the user is authenticated */
  isAuthenticated?: boolean;
  /** Whether the user is a link guest */
  isLinkGuest?: boolean;
  /** The caller's privilege level */
  callerPrivilege?: MemberPrivilege | undefined;
}

export interface MessageListHandle extends VirtuosoHandle {
  resetScrollBreakaway: () => void;
}

const FOOTER_HEIGHT = '10dvh';

const Footer = (): React.JSX.Element => (
  <div style={{ height: FOOTER_HEIGHT }} aria-hidden="true" />
);

const Scroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Scroller(props, ref) {
    return <div {...props} ref={ref} data-slot="scroll-area-viewport" />;
  }
);

const Header = (): React.JSX.Element => <div className="h-4" aria-hidden="true" />;

const components = { Header, Footer, Scroller };

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
    messages,
    streamingMessageIds,
    errorMessageId,
    modelName,
    onShare,
    onRegenerate,
    onEdit,
    onFork,
    isGroupChat,
    currentUserId,
    members,
    links,
    isAuthenticated,
    isLinkGuest,
    callerPrivilege,
  },
  ref
) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const userScrolledAwayRef = useRef(false);

  // Must exceed Footer height (10dvh) so scrollToIndex({ index: 'LAST' })
  // lands within the threshold and atBottomStateChange reports true.
  const [atBottomThreshold] = useState((): number => Math.ceil(window.innerHeight * 0.1) + 20);

  useImperativeHandle(ref, () => {
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) {
      return { resetScrollBreakaway: (): void => undefined } as MessageListHandle;
    }
    return {
      ...virtuoso,
      resetScrollBreakaway: (): void => {
        userScrolledAwayRef.current = false;
      },
    };
  });

  const handleAtBottomStateChange = useCallback((atBottom: boolean): void => {
    userScrolledAwayRef.current = !atBottom;
  }, []);

  const followOutput = useCallback((): boolean => {
    return !userScrolledAwayRef.current;
  }, []);

  const chatContext = useMemo(
    () =>
      buildChatContext({
        isAuthenticated: isAuthenticated ?? true,
        isLinkGuest: isLinkGuest ?? false,
        privilege: callerPrivilege,
        currentUserId,
        isGroupChat: isGroupChat ?? false,
      }),
    [isAuthenticated, isLinkGuest, callerPrivilege, currentUserId, isGroupChat]
  );

  const groups = useMemo(
    () => (isGroupChat ? groupConsecutiveMessages(messages) : null),
    [isGroupChat, messages]
  );

  if (messages.length === 0) {
    return (
      <div
        role="log"
        aria-label="Chat messages"
        data-testid="message-list-empty"
        className="flex flex-1 items-center justify-center"
      >
        <p className="text-muted-foreground">No messages yet</p>
      </div>
    );
  }

  function buildOptionalMessageProps(
    group: MessageGroup | undefined
  ): Partial<React.ComponentProps<typeof MessageItem>> {
    return {
      ...(group !== undefined && { group, isGroupChat: true as const }),
      ...(currentUserId !== undefined && { currentUserId }),
      ...(members !== undefined && { members }),
      ...(links !== undefined && { links }),
      ...(modelName !== undefined && { modelName }),
      ...(onShare !== undefined && { onShare }),
      ...(onRegenerate !== undefined && { onRegenerate }),
      ...(onEdit !== undefined && { onEdit }),
      ...(onFork !== undefined && { onFork }),
    };
  }

  function renderMessageItem(
    message: Message,
    isStreaming: boolean,
    isError: boolean,
    group?: MessageGroup
  ): React.JSX.Element | null {
    const msgContext: MessageContext = {
      message,
      isStreaming,
      isError,
      isMultiModel: isMultiModelResponse(messages, message.id),
      canRegenerate: canRegenerateMessage(
        messages,
        message.id,
        chatContext.currentUserId ?? '',
        chatContext.isGroupChat
      ),
    };
    const allowedActions = resolveMessageActions(chatContext, msgContext);
    return (
      <MessageItem
        key={group?.id ?? message.id}
        message={message}
        allowedActions={allowedActions}
        isStreaming={isStreaming}
        isError={isError}
        {...buildOptionalMessageProps(group)}
      />
    );
  }

  const assistantCount = messages.filter((m) => m.role === 'assistant').length;
  const costCount = messages.filter((m) => m.cost != null).length;

  if (groups) {
    return (
      <div
        role="log"
        aria-label="Chat messages"
        data-testid="message-list"
        data-assistant-count={assistantCount}
        data-cost-count={costCount}
        className="h-full min-h-0 flex-1"
      >
        <Virtuoso
          ref={virtuosoRef}
          data={groups}
          followOutput={followOutput}
          atBottomStateChange={handleAtBottomStateChange}
          atBottomThreshold={atBottomThreshold}
          {...(env.isE2E && {
            initialItemCount: groups.length,
            increaseViewportBy: { top: 999_999, bottom: 999_999 },
          })}
          itemContent={(_index, group) => {
            const firstMessage = group.messages[0];
            if (!firstMessage) return null;
            const isStreamingGroup = group.messages.some(
              (m) => streamingMessageIds?.has(m.id) ?? false
            );
            const isErrorGroup = group.messages.some(
              (m) => m.id === errorMessageId || m.errorCode !== undefined
            );
            return renderMessageItem(firstMessage, isStreamingGroup, isErrorGroup, group);
          }}
          components={components}
        />
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-label="Chat messages"
      data-testid="message-list"
      data-assistant-count={assistantCount}
      data-cost-count={costCount}
      className="h-full min-h-0 flex-1"
    >
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={atBottomThreshold}
        {...(env.isE2E && {
          initialItemCount: messages.length,
          increaseViewportBy: { top: 999_999, bottom: 999_999 },
        })}
        itemContent={(_index, message) => {
          const isStreamingMsg = streamingMessageIds?.has(message.id) ?? false;
          const isErrorMsg = message.id === errorMessageId || message.errorCode !== undefined;
          return renderMessageItem(message, isStreamingMsg, isErrorMsg);
        }}
        components={components}
      />
    </div>
  );
});
