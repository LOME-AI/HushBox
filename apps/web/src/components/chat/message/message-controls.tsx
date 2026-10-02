import * as React from 'react';
import { Check, Copy, GitBranch, Pencil, RefreshCw, Share2 } from 'lucide-react';
import { noticeText, TEST_IDS } from '@hushbox/shared';
import { Tooltip, TooltipContent, TooltipTrigger, cn, useCopyToClipboard } from '@hushbox/ui';
import { IconButton } from '@hushbox/ui/button';
import type { Message } from '@/lib/api/api';
import type { MessageAction } from '@/lib/chat/message-actions';
import type { NoticeReason } from '@hushbox/shared';

export interface MessageHandlers {
  /** Re-runs a turn: Regenerate on a reply, Retry on a user message. */
  onRegenerate?: ((messageId: string) => void) | undefined;
  onEdit?: ((messageId: string, content: string) => void) | undefined;
  onFork?: ((messageId: string) => void) | undefined;
  onShare?: ((messageId: string) => void) | undefined;
  /** The text Copy puts on the clipboard, read at the moment of the click. */
  copyText: () => string;
}

interface Control {
  key: string;
  label: string;
  tooltip?: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  refusal?: NoticeReason | undefined;
}

function ControlButton({
  control,
  refusalId,
}: Readonly<{ control: Control; refusalId: string }>): React.JSX.Element {
  const { label, tooltip, icon, onClick, refusal } = control;
  const refusalText = refusal === undefined ? undefined : noticeText(refusal);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            icon={icon}
            size="sm"
            aria-label={label}
            className={cn(
              'text-muted-foreground hover:text-foreground',
              refusalText !== undefined && 'cursor-not-allowed opacity-50'
            )}
            onClick={() => {
              if (refusalText === undefined) onClick();
            }}
            // A refused re-run stays hoverable and focusable (`aria-disabled`, never
            // `disabled`), so its reason stays reachable rather than leaving a dead button.
            {...(refusalText !== undefined && {
              'aria-disabled': true,
              'aria-describedby': refusalId,
            })}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{refusalText ?? tooltip ?? label}</p>
        </TooltipContent>
      </Tooltip>
      {refusalText !== undefined && (
        <span id={refusalId} className="sr-only">
          {refusalText}
        </span>
      )}
    </>
  );
}

function userControls(
  message: Message,
  allowed: ReadonlySet<MessageAction>,
  handlers: MessageHandlers,
  regenerateRefusal: NoticeReason | undefined
): Control[] {
  const { onRegenerate, onEdit } = handlers;
  const controls: Control[] = [];
  if (allowed.has('retry') && onRegenerate) {
    controls.push({
      key: 'retry',
      label: 'Retry',
      icon: RefreshCw,
      onClick: () => {
        onRegenerate(message.id);
      },
      refusal: regenerateRefusal,
    });
  }
  if (allowed.has('edit') && onEdit) {
    controls.push({
      key: 'edit',
      label: 'Edit',
      icon: Pencil,
      onClick: () => {
        onEdit(message.id, message.content);
      },
    });
  }
  return controls;
}

function replyControls(
  message: Message,
  allowed: ReadonlySet<MessageAction>,
  handlers: MessageHandlers,
  regenerateRefusal: NoticeReason | undefined
): Control[] {
  const { onRegenerate, onFork, onShare } = handlers;
  const controls: Control[] = [];
  if (allowed.has('regenerate') && onRegenerate) {
    controls.push({
      key: 'regenerate',
      label: 'Regenerate',
      icon: RefreshCw,
      onClick: () => {
        onRegenerate(message.id);
      },
      refusal: regenerateRefusal,
    });
  }
  if (allowed.has('fork') && onFork) {
    controls.push({
      key: 'fork',
      label: 'Fork',
      icon: GitBranch,
      onClick: () => {
        onFork(message.id);
      },
    });
  }
  if (allowed.has('share') && onShare) {
    controls.push({
      key: 'share',
      label: 'Share',
      icon: Share2,
      onClick: () => {
        onShare(message.id);
      },
    });
  }
  return controls;
}

/**
 * A message's controls, always visible: Retry, Edit, Copy under a user message;
 * Regenerate, Fork, Share, Copy in a reply's footer. A user message never offers
 * Fork. Which controls show is `allowed`, as `resolveMessageActions` decided it,
 * less any action whose handler the host does not supply.
 */
export function MessageControls({
  message,
  allowed,
  handlers,
  regenerateRefusal,
}: Readonly<{
  message: Message;
  allowed: ReadonlySet<MessageAction>;
  handlers: MessageHandlers;
  regenerateRefusal?: NoticeReason | undefined;
}>): React.JSX.Element | null {
  const { copy, copied } = useCopyToClipboard();
  const build = message.role === 'user' ? userControls : replyControls;
  const controls = build(message, allowed, handlers, regenerateRefusal);
  if (allowed.has('copy')) {
    controls.push({
      key: 'copy',
      label: copied ? 'Copied' : 'Copy',
      tooltip: copied ? 'Copied!' : 'Copy',
      icon: copied ? Check : Copy,
      onClick: () => {
        void copy(handlers.copyText());
      },
    });
  }
  if (controls.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Message actions"
      data-testid={TEST_IDS.messageActions}
      className="ml-auto flex flex-wrap items-center justify-end gap-0.5"
    >
      {controls.map((control) => (
        <ControlButton
          key={control.key}
          control={control}
          refusalId={`${control.key}-refusal-${message.id}`}
        />
      ))}
    </div>
  );
}
