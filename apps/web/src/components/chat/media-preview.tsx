import * as React from 'react';
import { Download } from 'lucide-react';
import { Button, cn, Img } from '@hushbox/ui';
import { friendlyErrorMessage, ERROR_CODE_STORAGE_READ_FAILED } from '@hushbox/shared';
import { buildDownloadFilename } from '@/lib/media-filename';
import { MediaModal } from './media-modal';

function MediaProgressBar({ percent }: Readonly<{ percent: number }>): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      data-testid="media-progress-bar"
      className="bg-background h-1.5 w-full max-w-xs overflow-hidden rounded-full"
    >
      <div
        className="bg-primary h-full transition-[width] duration-200 ease-out"
        style={{ width: `${String(clamped)}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

function resolvePlaceholderLabel(
  status: 'loading' | 'error',
  loadingLabel: string | undefined
): string {
  if (status === 'loading') return loadingLabel ?? 'Loading media…';
  // Error path uses the friendly mapping (Lane 9 handoff): single source of
  // truth for user-facing error wording lives in `error-messages.ts`.
  return friendlyErrorMessage(ERROR_CODE_STORAGE_READ_FAILED);
}

export function MediaPlaceholder({
  width,
  height,
  status,
  /**
   * 0-100 progress for in-flight long-running media generations (today: video).
   * When set, renders a progress bar and the percent. Hidden when omitted.
   */
  progressPercent,
  /**
   * Optional override label for the loading state — used when the parent
   * knows the media type via `model:media:start` (e.g. "Generating image…",
   * "Generating video…"). Falls back to the generic "Loading media…".
   */
  loadingLabel,
}: Readonly<{
  width: number | null | undefined;
  height: number | null | undefined;
  status: 'loading' | 'error';
  progressPercent?: number | undefined;
  loadingLabel?: string | undefined;
}>): React.JSX.Element {
  const aspectRatio = width && height ? `${String(width)} / ${String(height)}` : '1 / 1';
  const label = resolvePlaceholderLabel(status, loadingLabel);
  const showProgress = status === 'loading' && typeof progressPercent === 'number';
  // Once we hit 95% the server is still finalising — surface that so users
  // don't read "stuck at 95%" as a failure (Plan §wire-up).
  const isAlmostThere = showProgress && progressPercent >= 95;
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        'bg-muted flex w-full max-w-md flex-col items-center justify-center gap-2 rounded-md border p-4 text-sm',
        status === 'error' && 'text-destructive'
      )}
      style={{ aspectRatio }}
    >
      <span>{isAlmostThere ? 'Almost there…' : label}</span>
      {showProgress && <MediaProgressBar percent={progressPercent} />}
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
  /**
   * Forwarded as HTML `width`/`height` so the browser reserves aspect-ratio
   * layout space before bytes load. Without this an unloaded media element
   * has a 0×0 bounding box, which makes Virtuoso mis-measure the row height
   * and breaks `scrollIntoView` math inside the virtualized chat list.
   */
  width?: number | null | undefined;
  height?: number | null | undefined;
  className?: string;
}

/**
 * Shared renderer for a decrypted media blob. Wraps img/video/audio with a
 * download button and (for image/video) a fullscreen modal trigger. Callers
 * own the fetch+decrypt lifecycle and pass in a ready blob URL + metadata —
 * this component is purely presentational.
 */
export function MediaPreview({
  blobUrl,
  mimeType,
  contentType,
  ariaPrefix,
  width,
  height,
  className,
}: Readonly<MediaPreviewProps>): React.JSX.Element {
  const [modalOpen, setModalOpen] = React.useState(false);
  const isImage = contentType === 'image';
  const isVideo = contentType === 'video';
  const isAudio = contentType === 'audio';
  const mediaAlt = `${ariaPrefix} media`;
  // Modal alt is type-specific so screen-reader users learn whether they're
  // entering an image lightbox or a video player.
  const modalAlt = isVideo ? `${ariaPrefix} video` : mediaAlt;
  const downloadFilename = buildDownloadFilename(contentType, mimeType);
  const dimensionProps = {
    ...(width != null && { width }),
    ...(height != null && { height }),
  };

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
          <Img
            src={blobUrl}
            alt={mediaAlt}
            loading="eager"
            {...dimensionProps}
            className="max-h-96 w-full rounded-md object-contain"
          />
        </button>
      )}
      {isVideo && (
        // Wrap the inline preview in a click-to-fullscreen trigger for parity
        // with images (Lane 13: video should be polymorphic with image's
        // lightbox affordance). The inner <video> still has native controls
        // so users can scrub without entering the modal.
        // AI-generated media has no caption source today; revisit when
        // transcription becomes available.
        <button
          type="button"
          onClick={() => {
            setModalOpen(true);
          }}
          className="block w-full cursor-zoom-in rounded-md border"
          aria-label="Open video in fullscreen"
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- AI-generated video: no caption track is available; aria-label provides accessible name */}
          <video
            src={blobUrl}
            controls
            preload="metadata"
            {...dimensionProps}
            className="max-h-96 w-full rounded-md"
            aria-label={`${ariaPrefix} video`}
            // Stop propagation so clicking the native controls doesn't open
            // the modal — only clicking the surrounding frame does.
            onClick={(event) => {
              event.stopPropagation();
            }}
          />
        </button>
      )}
      {isAudio && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- AI-generated audio: no caption track is available; aria-label provides accessible name
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

      {(isImage || isVideo) && (
        <MediaModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          blobUrl={blobUrl}
          mimeType={mimeType}
          alt={modalAlt}
        />
      )}
    </div>
  );
}
