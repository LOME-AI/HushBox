import * as React from 'react';
import { Download } from 'lucide-react';
import { Button, cn } from '@hushbox/ui';
import { buildDownloadFilename } from '@/lib/media-filename';
import { MediaModal } from './media-modal';

export function MediaPlaceholder({
  width,
  height,
  status,
}: Readonly<{
  width: number | null | undefined;
  height: number | null | undefined;
  status: 'loading' | 'error';
}>): React.JSX.Element {
  const aspectRatio = width && height ? `${String(width)} / ${String(height)}` : '1 / 1';
  const label = status === 'loading' ? 'Loading media…' : 'Failed to load media';
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        'bg-muted flex w-full max-w-md items-center justify-center rounded-md border text-sm',
        status === 'error' && 'text-destructive'
      )}
      style={{ aspectRatio }}
    >
      <span>{label}</span>
    </div>
  );
}

export interface MediaPreviewProps {
  blobUrl: string;
  mimeType: string;
  contentType: 'image' | 'audio' | 'video';
  /**
   * Accessibility prefix. Images get `"{ariaPrefix} media"`; video/audio get
   * `"{ariaPrefix} video"` / `"{ariaPrefix} audio"`. Keep short — e.g.,
   * `"Generated"` for member-side, `"Shared"` for share-recipient side.
   */
  ariaPrefix: string;
  className?: string;
}

/**
 * Shared renderer for a decrypted media blob. Wraps img/video/audio with a
 * download button and (for images) a lightbox modal. Callers own the
 * fetch+decrypt lifecycle and pass in a ready blob URL + metadata — this
 * component is purely presentational.
 */
export function MediaPreview({
  blobUrl,
  mimeType,
  contentType,
  ariaPrefix,
  className,
}: Readonly<MediaPreviewProps>): React.JSX.Element {
  const [modalOpen, setModalOpen] = React.useState(false);
  const isImage = contentType === 'image';
  const isVideo = contentType === 'video';
  const isAudio = contentType === 'audio';
  const mediaAlt = `${ariaPrefix} media`;
  const downloadFilename = buildDownloadFilename(contentType, mimeType);

  return (
    <div className={cn('relative inline-block max-w-md', className)}>
      {isImage && (
        <button
          type="button"
          onClick={() => {
            setModalOpen(true);
          }}
          className="block cursor-zoom-in rounded-md border"
          aria-label="Open image in lightbox"
        >
          <img src={blobUrl} alt={mediaAlt} className="max-h-96 w-full rounded-md object-contain" />
        </button>
      )}
      {isVideo && (
        <video
          src={blobUrl}
          controls
          preload="metadata"
          className="max-h-96 w-full rounded-md border"
          aria-label={`${ariaPrefix} video`}
        >
          <track kind="captions" />
        </video>
      )}
      {isAudio && (
        <audio
          src={blobUrl}
          controls
          preload="none"
          className="w-full"
          aria-label={`${ariaPrefix} audio`}
        />
      )}

      <a
        href={blobUrl}
        download={downloadFilename}
        className="absolute top-2 right-2 inline-flex"
        aria-label="Download media"
      >
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="h-7 w-7 opacity-80 hover:opacity-100"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </a>

      {isImage && (
        <MediaModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          blobUrl={blobUrl}
          mimeType={mimeType}
          alt={mediaAlt}
        />
      )}
    </div>
  );
}
