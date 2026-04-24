import * as React from 'react';
import { useDecryptedMedia } from '@/hooks/use-decrypted-media';
import { MediaPlaceholder, MediaPreview } from './media-preview';
import type { MessageMediaItem } from '@/lib/api';

interface MediaContentItemProps {
  item: MessageMediaItem;
  conversationId: string;
  epochNumber: number;
  wrappedContentKey: string;
  className?: string;
}

/**
 * Renders a single media content item (image/video/audio) inside an
 * authenticated conversation. Fetches + decrypts bytes on mount, then delegates
 * rendering to `MediaPreview`.
 */
export function MediaContentItem({
  item,
  conversationId,
  epochNumber,
  wrappedContentKey,
  className,
}: Readonly<MediaContentItemProps>): React.JSX.Element {
  const { blobUrl, isLoading, error } = useDecryptedMedia({
    contentItemId: item.id,
    conversationId,
    epochNumber,
    wrappedContentKey,
    mimeType: item.mimeType,
  });

  if (error) {
    return <MediaPlaceholder width={item.width} height={item.height} status="error" />;
  }
  if (isLoading || !blobUrl) {
    return <MediaPlaceholder width={item.width} height={item.height} status="loading" />;
  }

  return (
    <MediaPreview
      blobUrl={blobUrl}
      mimeType={item.mimeType}
      contentType={item.contentType}
      ariaPrefix="Generated"
      {...(className !== undefined && { className })}
    />
  );
}
