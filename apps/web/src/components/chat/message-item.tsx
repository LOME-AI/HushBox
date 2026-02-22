import * as React from 'react';
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@hushbox/ui';
import { Check, Copy, Share2 } from 'lucide-react';
import type { Message } from '@/lib/api';
import type { MessageGroup } from '@/lib/chat-sender';
import { getSenderLabel, isOwnMessage } from '@/lib/chat-sender';
import { MarkdownRenderer } from './markdown-renderer';
import { MessageCost } from './message-cost';
import { ThinkingIndicator } from './thinking-indicator';

interface MemberInfo {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

interface MessageItemProps {
  message: Message;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /** Display name of the selected model, shown in thinking indicator */
  modelName?: string;
  isError?: boolean;
  onRetry?: () => void;
  onShare?: (messageId: string) => void;
  /** Group of consecutive messages (group chat mode) */
  group?: MessageGroup;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for determining alignment and labels */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
}

interface RetryButtonProps {
  onRetry: () => void;
}

function RetryButton({ onRetry }: Readonly<RetryButtonProps>): React.JSX.Element {
  return (
    <div className="px-4 pt-2">
      <Button variant="outline" size="sm" onClick={onRetry} aria-label="Retry">
        Retry
      </Button>
    </div>
  );
}

function computeContainerClasses(
  isUser: boolean,
  isGroupedUser: boolean,
  ownMessage: boolean
): string {
  if (!isUser) {
    return cn('pt-1.5 pb-3', 'w-full px-4 pb-7');
  }
  if (isGroupedUser && !ownMessage) {
    return cn('pt-1.5 pb-3', 'mr-auto ml-4 w-fit max-w-[82%]');
  }
  return cn('pt-1.5 pb-3', 'mr-4 ml-auto w-fit max-w-[82%]');
}

function computeBubbleClasses(
  isUser: boolean,
  isGroupedUser: boolean,
  ownMessage: boolean
): string {
  if (!isUser) {
    return cn('px-4 py-2', 'text-foreground overflow-hidden');
  }
  if (isGroupedUser && !ownMessage) {
    return cn('px-4 py-2', 'bg-muted text-foreground rounded-lg');
  }
  return cn('px-4 py-2', 'bg-message-user text-foreground rounded-lg');
}

function MessageActions({
  primaryMessage,
  onShare,
  copied,
  onCopy,
}: Readonly<{
  primaryMessage: Message;
  onShare?: (messageId: string) => void;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element {
  return (
    <div className="absolute right-0 -bottom-1 left-0 flex translate-y-full items-center justify-between px-1">
      {primaryMessage.cost && <MessageCost cost={primaryMessage.cost} />}

      <div className="ml-auto flex items-center gap-0.5">
        {onShare && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                onClick={() => {
                  onShare(primaryMessage.id);
                }}
                aria-label="Share"
              >
                <Share2 className="h-3 w-3" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Share</p>
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              onClick={onCopy}
              aria-label={copied ? 'Copied' : 'Copy'}
            >
              {copied ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Copy className="h-3 w-3" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{copied ? 'Copied!' : 'Copy'}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

interface MessageDisplayState {
  isGroupedUser: boolean;
  effectiveRole: string;
  isUser: boolean;
  senderLabel: string | undefined;
  ownMessage: boolean;
  messagesToRender: Message[];
  primaryMessage: Message;
}

interface MessageDisplayInput {
  message: Message;
  group: MessageGroup | undefined;
  isGroupChat: boolean | undefined;
  currentUserId: string | undefined;
  members: MemberInfo[] | undefined;
}

function resolveGroupIdentity(
  isGroupedUser: boolean,
  group: MessageGroup | undefined,
  currentUserId: string | undefined,
  members: MemberInfo[] | undefined
): { senderLabel: string | undefined; ownMessage: boolean } {
  if (!isGroupedUser || !currentUserId || !group) {
    return { senderLabel: undefined, ownMessage: true };
  }
  return {
    senderLabel: getSenderLabel(group.senderId, currentUserId, members ?? [], true),
    ownMessage: isOwnMessage(group.senderId, currentUserId),
  };
}

function computeMessageDisplayState(input: MessageDisplayInput): MessageDisplayState {
  const { message, group, isGroupChat, currentUserId, members } = input;
  const isGroupedUser = !!group && group.role === 'user' && !!isGroupChat;
  const effectiveRole = group ? group.role : message.role;
  const isUser = effectiveRole === 'user';
  const { senderLabel, ownMessage } = resolveGroupIdentity(
    isGroupedUser,
    group,
    currentUserId,
    members
  );
  const messagesToRender = isGroupedUser ? group.messages : [message];
  const primaryMessage = messagesToRender[0] ?? message;
  return {
    isGroupedUser,
    effectiveRole,
    isUser,
    senderLabel,
    ownMessage,
    messagesToRender,
    primaryMessage,
  };
}

function AIMessageContent({
  primaryMessage,
  isStreaming,
  modelName,
  isError,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
  modelName: string | undefined;
  isError: boolean | undefined;
}>): React.JSX.Element {
  if (isStreaming && primaryMessage.content === '') {
    return <ThinkingIndicator modelName={modelName ?? ''} />;
  }
  return (
    <MarkdownRenderer
      content={primaryMessage.content}
      isError={isError}
      isStreaming={isStreaming}
    />
  );
}

function UserMessageContent({
  messagesToRender,
  isGroupedUser,
  message,
}: Readonly<{
  messagesToRender: Message[];
  isGroupedUser: boolean;
  message: Message;
}>): React.JSX.Element {
  if (isGroupedUser) {
    return (
      <>
        {messagesToRender.map((msg, index) => (
          <p
            key={msg.id}
            className={cn(
              'text-base leading-relaxed break-words whitespace-pre-wrap',
              index > 0 && 'mt-3'
            )}
          >
            {msg.content}
          </p>
        ))}
      </>
    );
  }
  return (
    <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{message.content}</p>
  );
}

export function MessageItem({
  message,
  isStreaming,
  modelName,
  isError,
  onRetry,
  onShare,
  group,
  isGroupChat,
  currentUserId,
  members,
}: Readonly<MessageItemProps>): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const {
    isGroupedUser,
    effectiveRole,
    isUser,
    senderLabel,
    ownMessage,
    messagesToRender,
    primaryMessage,
  } = computeMessageDisplayState({ message, group, isGroupChat, currentUserId, members });

  const handleCopy = async (): Promise<void> => {
    const allContent = messagesToRender.map((m) => m.content).join('\n\n');
    await navigator.clipboard.writeText(allContent);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const containerClasses = computeContainerClasses(isUser, isGroupedUser, ownMessage);
  const bubbleClasses = computeBubbleClasses(isUser, isGroupedUser, ownMessage);

  return (
    <div className="mx-auto w-full max-w-3xl">
      {senderLabel && (
        <p
          data-testid="sender-label"
          className={cn(
            'text-foreground mt-1 px-1 text-xs',
            ownMessage ? 'mr-4 text-right' : 'ml-4'
          )}
        >
          {senderLabel}
        </p>
      )}
      <div
        data-testid="message-item"
        data-role={effectiveRole}
        {...(isError ? { 'data-error': 'true' } : {})}
        className={containerClasses}
      >
        <div className="group relative">
          <div className={bubbleClasses}>
            {isUser ? (
              <UserMessageContent
                messagesToRender={messagesToRender}
                isGroupedUser={isGroupedUser}
                message={message}
              />
            ) : (
              <div className="w-full overflow-hidden text-base leading-relaxed break-words">
                <AIMessageContent
                  primaryMessage={primaryMessage}
                  isStreaming={isStreaming}
                  modelName={modelName}
                  isError={isError}
                />
              </div>
            )}
          </div>

          {isError && onRetry && <RetryButton onRetry={onRetry} />}

          {!isUser && !isError && (
            <MessageActions
              primaryMessage={primaryMessage}
              {...(onShare !== undefined && { onShare })}
              copied={copied}
              onCopy={() => void handleCopy()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
