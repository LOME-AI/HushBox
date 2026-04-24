import * as React from 'react';
import { useDecryptedSharedMedia } from '@/hooks/use-decrypted-shared-media';
import { MediaPlaceholder, MediaPreview } from './media-preview';
import type { SharedContentItem } from '@/hooks/use-shared-message';

type SharedMediaItem = Extract<SharedContentItem, { type: 'media' }>;

interface SharedMediaContentItemProps {
  item: SharedMediaItem;
  /** Message-level content key (already unwrapped from the shareSecret). */
  contentKey: Uint8Array;
  className?: string;
}

/**
 * Share-side wrapper. Uses the presigned URL pre-baked into the share
 * response and the content key unwrapped once from the URL-fragment
 * `shareSecret`. Rendering is delegated to `MediaPreview`.
 */
export function SharedMediaContentItem({
  item,
  contentKey,
  className,
}: Readonly<SharedMediaContentItemProps>): React.JSX.Element {
  const { blobUrl, isLoading, error } = useDecryptedSharedMedia({
    downloadUrl: item.downloadUrl,
    contentKey,
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
      ariaPrefix="Shared"
      {...(className !== undefined && { className })}
    />
  );
}
