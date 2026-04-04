import * as React from 'react';
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@hushbox/ui';
import { shortenModelName, friendlyErrorMessage } from '@hushbox/shared';
import { getModelColor } from '@/lib/model-color';
import { useModels } from '@/hooks/models';
import { Check, Copy, GitBranch, Pencil, RefreshCw, Share2 } from 'lucide-react';
import type { Message } from '@/lib/api';
import type { MessageAction } from '@/lib/message-actions';
import type { MessageGroup, LinkInfo } from '@/lib/chat-sender';
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
  /** Set of actions allowed for this message, determined by resolveMessageActions */
  allowedActions: Set<MessageAction>;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /** Display name of the selected model, shown in thinking indicator */
  modelName?: string;
  isError?: boolean;
  onRetry?: () => void;
  onShare?: (messageId: string) => void;
  /** Called when user clicks regenerate (AI) or retry (user) */
  onRegenerate?: (messageId: string) => void;
  /** Called when user clicks edit on a user message */
  onEdit?: (messageId: string, content: string) => void;
  /** Called when user clicks fork on any message */
  onFork?: (messageId: string) => void;
  /** Group of consecutive messages (group chat mode) */
  group?: MessageGroup;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for determining alignment and labels */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
  /** Shared links for resolving link guest sender names */
  links?: LinkInfo[];
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

function TooltipIconButton({
  label,
  tooltip,
  icon,
  onClick,
}: Readonly<{
  label: string;
  tooltip?: string;
  icon: React.ReactNode;
  onClick: () => void;
}>): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
          onClick={onClick}
          aria-label={label}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{tooltip ?? label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function CopyButton({
  copied,
  onCopy,
}: Readonly<{
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element {
  return (
    <TooltipIconButton
      label={copied ? 'Copied' : 'Copy'}
      tooltip={copied ? 'Copied!' : 'Copy'}
      icon={
        copied ? (
          <Check className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3" aria-hidden="true" />
        )
      }
      onClick={onCopy}
    />
  );
}

interface UserActionEntry {
  key: string;
  render: () => React.JSX.Element;
}

function UserMessageActions({
  message,
  allowedActions,
  onRegenerate,
  onEdit,
  onFork,
  copied,
  onCopy,
}: Readonly<{
  message: Message;
  allowedActions: Set<MessageAction>;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element | null {
  const actions: UserActionEntry[] = [];

  if (allowedActions.has('retry') && onRegenerate) {
    const handler = onRegenerate;
    actions.push({
      key: 'retry',
      render: () => (
        <TooltipIconButton
          label="Retry"
          icon={<RefreshCw className="h-3 w-3" aria-hidden="true" />}
          onClick={() => {
            handler(message.id);
          }}
        />
      ),
    });
  }

  if (allowedActions.has('edit') && onEdit) {
    const handler = onEdit;
    actions.push({
      key: 'edit',
      render: () => (
        <TooltipIconButton
          label="Edit"
          icon={<Pencil className="h-3 w-3" aria-hidden="true" />}
          onClick={() => {
            handler(message.id, message.content);
          }}
        />
      ),
    });
  }

  if (allowedActions.has('fork') && onFork) {
    const handler = onFork;
    actions.push({
      key: 'fork',
      render: () => (
        <TooltipIconButton
          label="Fork"
          icon={<GitBranch className="h-3 w-3" aria-hidden="true" />}
          onClick={() => {
            handler(message.id);
          }}
        />
      ),
    });
  }

  if (allowedActions.has('copy')) {
    actions.push({
      key: 'copy',
      render: () => <CopyButton copied={copied} onCopy={onCopy} />,
    });
  }

  if (actions.length === 0) return null;

  return (
    <div className="absolute right-0 -bottom-1 left-0 flex translate-y-full items-center justify-end px-1">
      <div className="ml-auto flex items-center gap-0.5">
        {actions.map((a) => (
          <React.Fragment key={a.key}>{a.render()}</React.Fragment>
        ))}
      </div>
    </div>
  );
}

function MessageActions({
  primaryMessage,
  allowedActions,
  onShare,
  onRegenerate,
  onFork,
  copied,
  onCopy,
}: Readonly<{
  primaryMessage: Message;
  allowedActions: Set<MessageAction>;
  onShare?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element {
  const showRegenerate = allowedActions.has('regenerate') && onRegenerate;
  const showFork = allowedActions.has('fork') && onFork;
  const showShare = allowedActions.has('share') && onShare;
  const showCopy = allowedActions.has('copy');

  return (
    <div className="absolute right-0 -bottom-1 left-0 flex translate-y-full items-center justify-between px-1">
      {primaryMessage.cost && <MessageCost cost={primaryMessage.cost} />}

      <div className="ml-auto flex items-center gap-0.5">
        {showRegenerate && (
          <TooltipIconButton
            label="Regenerate"
            icon={<RefreshCw className="h-3 w-3" aria-hidden="true" />}
            onClick={() => {
              onRegenerate(primaryMessage.id);
            }}
          />
        )}
        {showFork && (
          <TooltipIconButton
            label="Fork"
            icon={<GitBranch className="h-3 w-3" aria-hidden="true" />}
            onClick={() => {
              onFork(primaryMessage.id);
            }}
          />
        )}
        {showShare && (
          <TooltipIconButton
            label="Share"
            icon={<Share2 className="h-3 w-3" aria-hidden="true" />}
            onClick={() => {
              onShare(primaryMessage.id);
            }}
          />
        )}
        {showCopy && <CopyButton copied={copied} onCopy={onCopy} />}
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
  links: LinkInfo[] | undefined;
}

interface GroupIdentityInput {
  isGroupedUser: boolean;
  group: MessageGroup | undefined;
  currentUserId: string | undefined;
  members: MemberInfo[] | undefined;
  links: LinkInfo[] | undefined;
}

function resolveGroupIdentity(input: GroupIdentityInput): {
  senderLabel: string | undefined;
  ownMessage: boolean;
} {
  const { isGroupedUser, group, currentUserId, members, links } = input;
  if (!isGroupedUser || !currentUserId || !group) {
    return { senderLabel: undefined, ownMessage: true };
  }
  return {
    senderLabel: getSenderLabel({
      senderId: group.senderId,
      currentUserId,
      members: members ?? [],
      isGroupChat: true,
      links: links ?? [],
    }),
    ownMessage: isOwnMessage(group.senderId, currentUserId),
  };
}

function computeMessageDisplayState(input: MessageDisplayInput): MessageDisplayState {
  const { message, group, isGroupChat, currentUserId, members, links } = input;
  const isGroupedUser = !!group && group.role === 'user' && !!isGroupChat;
  const effectiveRole = group ? group.role : message.role;
  const isUser = effectiveRole === 'user';
  const { senderLabel, ownMessage } = resolveGroupIdentity({
    isGroupedUser,
    group,
    currentUserId,
    members,
    links,
  });
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
  const { data: modelsData } = useModels();

  if (primaryMessage.errorCode) {
    return (
      <p className="text-destructive text-sm" data-testid="model-error-message">
        {friendlyErrorMessage(primaryMessage.errorCode)}
      </p>
    );
  }
  if (isStreaming && primaryMessage.content === '') {
    const rawModelName = primaryMessage.modelName ?? modelName ?? '';
    const resolved = modelsData?.models.find((m) => m.id === rawModelName);
    return <ThinkingIndicator modelName={resolved?.name ?? rawModelName} />;
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

function AIMessageNametag({
  primaryMessage,
  modelName,
}: Readonly<{
  primaryMessage: Message;
  modelName: string | undefined;
}>): React.JSX.Element {
  const { data: modelsData } = useModels();

  const nametagText = (() => {
    if (primaryMessage.modelName) {
      const resolved = modelsData?.models.find((m) => m.id === primaryMessage.modelName);
      return shortenModelName(resolved?.name ?? primaryMessage.modelName);
    }
    return modelName ? shortenModelName(modelName) : 'AI';
  })();

  const color = getModelColor(primaryMessage.modelName ?? modelName ?? 'AI');

  return (
    <p
      data-testid="model-nametag"
      className="mb-0.5 inline-block rounded bg-[var(--nametag-bg)] px-1.5 py-0.5 text-xs text-[var(--nametag-fg)] dark:bg-[var(--nametag-bg-dark)] dark:text-[var(--nametag-fg-dark)]"
      style={
        {
          '--nametag-bg': color.bg,
          '--nametag-fg': color.fg,
          '--nametag-bg-dark': color.bgDark,
          '--nametag-fg-dark': color.fgDark,
        } as React.CSSProperties
      }
    >
      {nametagText}
    </p>
  );
}

function buildUserActionProps(
  onRegenerate?: (messageId: string) => void,
  onEdit?: (messageId: string, content: string) => void,
  onFork?: (messageId: string) => void
): Record<string, unknown> {
  return {
    ...(onRegenerate != null && { onRegenerate }),
    ...(onEdit != null && { onEdit }),
    ...(onFork != null && { onFork }),
  };
}

function buildAssistantActionProps(
  onShare?: (messageId: string) => void,
  onRegenerate?: (messageId: string) => void,
  onFork?: (messageId: string) => void
): Record<string, unknown> {
  return {
    ...(onShare != null && { onShare }),
    ...(onRegenerate != null && { onRegenerate }),
    ...(onFork != null && { onFork }),
  };
}

function MessageActionButtons({
  isUser,
  primaryMessage,
  allowedActions,
  onRetry,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  copied,
  onCopy,
}: Readonly<{
  isUser: boolean;
  primaryMessage: Message;
  allowedActions: Set<MessageAction>;
  onRetry?: (() => void) | undefined;
  onShare?: ((messageId: string) => void) | undefined;
  onRegenerate?: ((messageId: string) => void) | undefined;
  onEdit?: ((messageId: string, content: string) => void) | undefined;
  onFork?: ((messageId: string) => void) | undefined;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element | null {
  const showRetryError = allowedActions.has('retry-error') && onRetry;

  if (isUser) {
    return (
      <>
        {showRetryError && <RetryButton onRetry={onRetry} />}
        <UserMessageActions
          message={primaryMessage}
          allowedActions={allowedActions}
          {...buildUserActionProps(onRegenerate, onEdit, onFork)}
          copied={copied}
          onCopy={onCopy}
        />
      </>
    );
  }

  return (
    <>
      {showRetryError && <RetryButton onRetry={onRetry} />}
      <MessageActions
        primaryMessage={primaryMessage}
        allowedActions={allowedActions}
        {...buildAssistantActionProps(onShare, onRegenerate, onFork)}
        copied={copied}
        onCopy={onCopy}
      />
    </>
  );
}

export function MessageItem({
  message,
  allowedActions,
  isStreaming,
  modelName,
  isError,
  onRetry,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  group,
  isGroupChat,
  currentUserId,
  members,
  links,
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
  } = computeMessageDisplayState({ message, group, isGroupChat, currentUserId, members, links });

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
              <>
                {(primaryMessage.content !== '' || isStreaming === true) && (
                  <AIMessageNametag primaryMessage={primaryMessage} modelName={modelName} />
                )}
                <div className="w-full overflow-hidden text-base leading-relaxed break-words">
                  <AIMessageContent
                    primaryMessage={primaryMessage}
                    isStreaming={isStreaming}
                    modelName={modelName}
                    isError={isError}
                  />
                </div>
              </>
            )}
          </div>

          <MessageActionButtons
            isUser={isUser}
            primaryMessage={primaryMessage}
            allowedActions={allowedActions}
            onRetry={onRetry}
            onShare={onShare}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
            onFork={onFork}
            copied={copied}
            onCopy={() => void handleCopy()}
          />
        </div>
      </div>
    </div>
  );
}
