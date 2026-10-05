import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import { InvalidKeysNotice } from '@/components/chat/message/invalid-keys-notice';
import { MessageMediaList } from '@/components/chat/message/message-media-list';
import type { RenderableMedia } from '@/components/chat/media/media-content-item';

/** Bubble visual variant. Mirrors the chat message bubble styles exactly. */
export type MessageBodyVariant = 'assistant' | 'user-own' | 'user-other';

const BUBBLE_VARIANT_CLASS: Record<MessageBodyVariant, string> = {
  assistant: 'py-2 text-foreground overflow-hidden',
  'user-own': 'px-4 py-2 bg-message-user text-foreground rounded-lg',
  'user-other': 'px-4 py-2 bg-muted text-foreground rounded-lg',
};

interface MessageBodyProps {
  variant: MessageBodyVariant;
  /** Text region, composed by the caller. */
  children?: React.ReactNode;
  /** Position-sorted media for the message; empty → no media block renders. */
  media: RenderableMedia[];
  /**
   * Error from resolving the message content key (missing/rotated epoch key).
   * Forwarded to the media list so undecryptable media shows an error instead of
   * a perpetual spinner.
   */
  contentKeyError?: Error | null;
  /** Accessibility prefix forwarded to each media item's label. */
  ariaPrefix: string;
  /**
   * The sender deleted their account and the server erased the content: the
   * bubble shows that in place of the text region and media.
   */
  deleted?: boolean | undefined;
  /**
   * The message's epoch holds keys that failed verification: the bubble says so
   * in place of the text region and media, rather than showing a generic
   * decryption failure.
   */
  invalidKeys?: boolean | undefined;
  className?: string;
}

/**
 * A message's bubble. Owns the bubble frame and the media list; the caller
 * composes the text region.
 */
export function MessageBody({
  variant,
  children,
  media,
  contentKeyError,
  ariaPrefix,
  deleted,
  invalidKeys,
  className,
}: Readonly<MessageBodyProps>): React.JSX.Element {
  if (deleted) {
    // No data-reading: the notice is chrome, not the sender's words, so it
    // stays in the sans, one size step down and muted like the chat's other
    // message-state lines.
    return (
      <div className={cn(BUBBLE_VARIANT_CLASS[variant], className)}>
        <p data-testid={TEST_IDS.messageDeleted} className="text-muted-foreground text-sm">
          Message deleted
        </p>
      </div>
    );
  }

  if (invalidKeys) {
    return (
      <div className={cn(BUBBLE_VARIANT_CLASS[variant], className)}>
        <InvalidKeysNotice />
      </div>
    );
  }

  return (
    // data-reading flips this bubble's subtree to the editorial serif (twin of
    // data-chrome), so one tag covers whatever text region the caller composes.
    <div data-reading="" className={cn(BUBBLE_VARIANT_CLASS[variant], className)}>
      {children}
      <MessageMediaList
        media={media}
        contentKeyError={contentKeyError ?? null}
        ariaPrefix={ariaPrefix}
      />
    </div>
  );
}
