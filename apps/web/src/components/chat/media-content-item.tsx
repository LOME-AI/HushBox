import * as React from 'react';
import { Download } from 'lucide-react';
import { Button, cn } from '@hushbox/ui';
import { useDecryptedMedia } from '@/hooks/use-decrypted-media';
import type { MessageMediaItem } from '@/lib/api';
import { MediaModal } from './media-modal';

interface MediaContentItemProps {
  item: MessageMediaItem;
  conversationId: string;
  epochNumber: number;
  wrappedContentKey: string;
  className?: string;
}

function getExtensionFromMime(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'bin';
}

/** Builds a user-friendly filename like `hushbox-image-20260417-103045.png`. */
function buildDownloadFilename(contentType: 'image' | 'audio' | 'video', mimeType: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());
  return `hushbox-${contentType}-${stamp}.${getExtensionFromMime(mimeType)}`;
}

function MediaPlaceholder({
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

/**
 * Renders a single media content item (image/video/audio).
 * Lazily fetches + decrypts bytes on mount, then renders a preview.
 * Click opens a lightbox modal.
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

  const [modalOpen, setModalOpen] = React.useState(false);

  if (error) {
    return <MediaPlaceholder width={item.width} height={item.height} status="error" />;
  }

  if (isLoading || !blobUrl) {
    return <MediaPlaceholder width={item.width} height={item.height} status="loading" />;
  }

  const isImage = item.contentType === 'image';
  const isVideo = item.contentType === 'video';
  const isAudio = item.contentType === 'audio';

  const downloadFilename = buildDownloadFilename(item.contentType, item.mimeType);

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
          <img
            src={blobUrl}
            alt="Generated media"
            className="max-h-96 w-full rounded-md object-contain"
          />
        </button>
      )}
      {isVideo && (
        <video
          src={blobUrl}
          controls
          preload="metadata"
          className="max-h-96 w-full rounded-md border"
          aria-label="Generated video"
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
          aria-label="Generated audio"
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
          mimeType={item.mimeType}
          alt="Generated media"
        />
      )}
    </div>
  );
}
