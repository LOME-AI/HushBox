import * as React from 'react';
import { cn } from '@hushbox/ui';
import { MessageMediaList } from './message-media-list';
import type { RenderableMedia } from './media-content-item';
import type { ContentKey } from '@hushbox/crypto';

/** Bubble visual variant. Mirrors the chat message bubble styles exactly. */
export type MessageBodyVariant = 'assistant' | 'user-own' | 'user-other';

const BUBBLE_VARIANT_CLASS: Record<MessageBodyVariant, string> = {
  assistant: 'px-4 py-2 text-foreground overflow-hidden',
  'user-own': 'px-4 py-2 bg-message-user text-foreground rounded-lg',
  'user-other': 'px-4 py-2 bg-muted text-foreground rounded-lg',
};

interface MessageBodyProps {
  variant: MessageBodyVariant;
  /**
   * Text region, composed by the caller: the chat passes its nametag / live
   * region / streaming placeholders; the share view passes rendered markdown.
   */
  children?: React.ReactNode;
  /** Position-sorted media for the message; empty → no media block renders. */
  media: RenderableMedia[];
  /** Message-level content key, resolved once upstream (null while resolving). */
  contentKey: ContentKey | null;
  /** Accessibility prefix forwarded to each media item ("Generated" | "Shared"). */
  ariaPrefix: string;
  className?: string;
}

/**
 * The single message bubble shared by the authenticated chat (`MessageItem`)
 * and the public share view. Owns the bubble frame and the media list; the
 * caller composes the text region. Keeping this one component means a shared
 * message renders byte-for-byte like the same message in chat.
 */
export function MessageBody({
  variant,
  children,
  media,
  contentKey,
  ariaPrefix,
  className,
}: Readonly<MessageBodyProps>): React.JSX.Element {
  return (
    <div className={cn(BUBBLE_VARIANT_CLASS[variant], className)}>
      {children}
      <MessageMediaList media={media} contentKey={contentKey} ariaPrefix={ariaPrefix} />
    </div>
  );
}
