import * as React from 'react';
import { MediaContentItem, type RenderableMedia } from './media-content-item';
import type { ContentKey } from '@hushbox/crypto';

interface MessageMediaListProps {
  /** Position-sorted media for the message; empty → renders nothing. */
  media: RenderableMedia[];
  /** Message-level content key, resolved once upstream (null while resolving). */
  contentKey: ContentKey | null;
  /** Accessibility prefix forwarded to each item ("Generated" | "Shared"). */
  ariaPrefix: string;
}

/**
 * Shared media container for a message: stacks each media item with the spacing
 * the chat bubble uses. Returns null when there are no media items so a
 * text-only message renders no empty container (preserves the chat's DOM).
 * Used by the chat bubble, the public share view, and the share dialog preview.
 */
export function MessageMediaList({
  media,
  contentKey,
  ariaPrefix,
}: Readonly<MessageMediaListProps>): React.JSX.Element | null {
  if (media.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {media.map((item) => (
        <MediaContentItem
          key={item.contentItemId}
          item={item}
          contentKey={contentKey}
          ariaPrefix={ariaPrefix}
        />
      ))}
    </div>
  );
}
