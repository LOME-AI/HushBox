import * as React from 'react';
import { Download } from 'lucide-react';
import { Button, Overlay } from '@hushbox/ui';
import { buildDownloadFilename } from '@/lib/media-filename';

interface MediaModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blobUrl: string | null;
  mimeType: string;
  alt?: string;
}

type ContentType = 'image' | 'video' | 'audio';

function getContentType(mimeType: string): ContentType | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

interface MediaElementProps {
  contentType: ContentType;
  blobUrl: string;
  alt: string | undefined;
}

function MediaElement({
  contentType,
  blobUrl,
  alt,
}: Readonly<MediaElementProps>): React.JSX.Element | null {
  if (contentType === 'image') {
    return (
      <img
        src={blobUrl}
        alt={alt ?? 'Generated media'}
        className="max-h-[85vh] max-w-full object-contain"
      />
    );
  }
  if (contentType === 'video') {
    // AI-generated media has no caption source today; revisit when
    // transcription becomes available. Empty <track> elements add no
    // accessibility value and risk WCAG misclassification, so omitted.
    return (
      <video
        src={blobUrl}
        controls
        className="max-h-[85vh] max-w-full"
        aria-label={alt ?? 'Generated video'}
      />
    );
  }
  return <audio src={blobUrl} controls className="w-full" aria-label={alt ?? 'Generated audio'} />;
}

function DownloadButton({
  blobUrl,
  filename,
}: Readonly<{ blobUrl: string; filename: string }>): React.JSX.Element {
  // Sit to the LEFT of the Overlay's close button (top-5 right-3) so the
  // affordances don't visually collide. Close button is size-4 (16px) with
  // 0.75rem right offset, so right-12 (3rem) leaves a comfortable gap.
  return (
    <a
      href={blobUrl}
      download={filename}
      className="absolute top-2 right-12 inline-flex"
      aria-label="Download media"
    >
      <Button
        type="button"
        size="icon"
        variant="secondary"
        className="h-7 w-7 opacity-90 hover:opacity-100"
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </a>
  );
}

/**
 * Lightbox for full-size media viewing. Renders the media at its natural
 * size within the viewport bounds with a dark backdrop, plus a download
 * affordance so the user can save the media without dismissing the modal
 * (WCAG 2.4.4 — link purpose in context).
 */
export function MediaModal({
  open,
  onOpenChange,
  blobUrl,
  mimeType,
  alt,
}: Readonly<MediaModalProps>): React.JSX.Element | null {
  if (!blobUrl) return null;

  const contentType = getContentType(mimeType);
  if (!contentType) return null;
  const downloadFilename = buildDownloadFilename(contentType, mimeType);

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={alt ?? 'Media viewer'}
      className="max-w-[95vw] p-2"
    >
      <div className="relative flex max-h-[85vh] items-center justify-center overflow-auto">
        <MediaElement contentType={contentType} blobUrl={blobUrl} alt={alt} />
        <DownloadButton blobUrl={blobUrl} filename={downloadFilename} />
      </div>
    </Overlay>
  );
}
