import { forwardRef, useCallback, useMemo } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageItem } from './message-item';
import type { Message } from '@/lib/api';
import { groupConsecutiveMessages } from '@/lib/chat-sender';

interface MemberInfo {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

interface MessageListProps {
  messages: Message[];
  streamingMessageId?: string | null | undefined;
  errorMessageId?: string | undefined;
  modelName?: string | undefined;
  onShare?: ((messageId: string) => void) | undefined;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for sender labels and alignment */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
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

export const MessageList = forwardRef<VirtuosoHandle, MessageListProps>(function MessageList(
  {
    messages,
    streamingMessageId,
    errorMessageId,
    modelName,
    onShare,
    isGroupChat,
    currentUserId,
    members,
  },
  ref
) {
  // eslint-disable-next-line sonarjs/function-return-type -- Virtuoso API requires this signature
  const followOutput = useCallback((isAtBottom: boolean): boolean | 'smooth' => {
    // eslint-disable-next-line sonarjs/no-selector-parameter -- Virtuoso API callback signature
    return isAtBottom ? 'smooth' : false;
  }, []);

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

  if (groups) {
    return (
      <div
        role="log"
        aria-label="Chat messages"
        data-testid="message-list"
        className="h-full min-h-0 flex-1"
      >
        <Virtuoso
          ref={ref}
          data={groups}
          followOutput={followOutput}
          atBottomThreshold={50}
          itemContent={(_index, group) => {
            const firstMessage = group.messages[0];
            if (!firstMessage) return null;
            return (
              <MessageItem
                key={group.id}
                message={firstMessage}
                group={group}
                isGroupChat
                {...(currentUserId !== undefined && { currentUserId })}
                {...(members !== undefined && { members })}
                isStreaming={group.messages.some((m) => m.id === streamingMessageId)}
                {...(modelName !== undefined && { modelName })}
                isError={group.messages.some((m) => m.id === errorMessageId)}
                {...(onShare !== undefined && { onShare })}
              />
            );
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
      className="h-full min-h-0 flex-1"
    >
      <Virtuoso
        ref={ref}
        data={messages}
        followOutput={followOutput}
        atBottomThreshold={50}
        itemContent={(_index, message) => (
          <MessageItem
            key={message.id}
            message={message}
            isStreaming={message.id === streamingMessageId}
            {...(modelName !== undefined && { modelName })}
            isError={message.id === errorMessageId}
            {...(onShare !== undefined && { onShare })}
          />
        )}
        components={components}
      />
    </div>
  );
});
