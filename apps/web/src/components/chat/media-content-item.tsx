import * as React from 'react';
import { useDecryptedMedia } from '@/hooks/use-decrypted-media';
import { MediaItemShell } from './media-item-shell';
import type { ContentKey } from '@hushbox/crypto';
import type { MessageMediaItem } from '@/lib/api';

interface MediaContentItemProps {
  item: MessageMediaItem;
  /**
   * Pre-unwrapped message content key. Resolved once at the message level by
   * `MessageMediaItems` (Plan §15.5: ONE ECIES unwrap per message, not N).
   */
  contentKey: ContentKey | null;
  className?: string;
}

/**
 * Renders a single media content item (image/video/audio) inside an
 * authenticated conversation. Fetches + decrypts bytes on mount, then delegates
 * the loading/error/preview rendering to `MediaItemShell`.
 */
export function MediaContentItem({
  item,
  contentKey,
  className,
}: Readonly<MediaContentItemProps>): React.JSX.Element {
  const { blobUrl, isLoading, error } = useDecryptedMedia({
    contentItemId: item.id,
    contentKey,
    mimeType: item.mimeType,
    ...(item.downloadUrl !== undefined && { preFetchedUrl: item.downloadUrl }),
  });

  return (
    <MediaItemShell
      blobUrl={blobUrl}
      isLoading={isLoading}
      error={error}
      mimeType={item.mimeType}
      contentType={item.contentType}
      width={item.width}
      height={item.height}
      ariaPrefix="Generated"
      {...(className !== undefined && { className })}
    />
  );
}
