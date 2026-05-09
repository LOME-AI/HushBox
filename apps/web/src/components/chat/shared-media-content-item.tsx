import * as React from 'react';
import { useDecryptedSharedMedia } from '@/hooks/use-decrypted-shared-media';
import { MediaItemShell } from './media-item-shell';
import type { ContentKey } from '@hushbox/crypto';
import type { SharedContentItem } from '@/hooks/use-shared-message';

type SharedMediaItem = Extract<SharedContentItem, { type: 'media' }>;

interface SharedMediaContentItemProps {
  item: SharedMediaItem;
  /** Message-level content key (already unwrapped from the shareSecret). */
  contentKey: ContentKey;
  className?: string;
}

/**
 * Share-side wrapper. Uses the presigned URL pre-baked into the share
 * response and the content key unwrapped once from the URL-fragment
 * `shareSecret`. The loading/error/preview tail is delegated to
 * `MediaItemShell`.
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

  return (
    <MediaItemShell
      blobUrl={blobUrl}
      isLoading={isLoading}
      error={error}
      mimeType={item.mimeType}
      contentType={item.contentType}
      width={item.width}
      height={item.height}
      ariaPrefix="Shared"
      {...(className !== undefined && { className })}
    />
  );
}
