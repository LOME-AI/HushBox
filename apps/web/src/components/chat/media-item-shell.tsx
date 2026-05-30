import * as React from 'react';
import { MediaPlaceholder, MediaPreview } from './media-preview';

interface MediaItemShellProps {
  /** Resolved blob URL, or null while loading / on error. */
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
  /** Mime type of the underlying media (passed through to the preview/download). */
  mimeType: string;
  /** Discriminates how the preview renders (image lightbox vs video/audio controls). */
  contentType: 'image' | 'audio' | 'video';
  /** Width hint for placeholder aspect ratio (null when unknown). */
  width: number | null | undefined;
  /** Height hint for placeholder aspect ratio (null when unknown). */
  height: number | null | undefined;
  /**
   * Accessibility prefix for `MediaPreview` — short noun like "Generated" for
   * member-side or "Shared" for share-recipient side.
   */
  ariaPrefix: string;
  /** Optional extra classes forwarded to the resolved preview. */
  className?: string;
}

/**
 * Shared error / loading / preview tail used by both member-side
 * (`MediaContentItem`) and share-recipient-side (`SharedMediaContentItem`)
 * media wrappers. Captures the parallel logic those wrappers used to inline:
 * surface an error placeholder when the decrypt hook reports failure, a
 * loading placeholder while bytes resolve, and otherwise hand off to
 * `MediaPreview`. The two wrappers stay distinct because they own *different*
 * decrypt hooks (auth-side fetches the URL itself; share-side gets a
 * pre-baked presigned URL).
 */
export function MediaItemShell({
  blobUrl,
  isLoading,
  error,
  mimeType,
  contentType,
  width,
  height,
  ariaPrefix,
  className,
}: Readonly<MediaItemShellProps>): React.JSX.Element {
  if (error) {
    return <MediaPlaceholder width={width} height={height} status="error" />;
  }
  if (isLoading || !blobUrl) {
    return <MediaPlaceholder width={width} height={height} status="loading" />;
  }
  return (
    <MediaPreview
      blobUrl={blobUrl}
      mimeType={mimeType}
      contentType={contentType}
      ariaPrefix={ariaPrefix}
      width={width}
      height={height}
      {...(className !== undefined && { className })}
    />
  );
}
