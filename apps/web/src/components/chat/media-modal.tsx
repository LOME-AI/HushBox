import * as React from 'react';
import { Img, Overlay } from '@hushbox/ui';

interface MediaModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blobUrl: string | null;
  mimeType: string;
  alt?: string;
}

/**
 * Lightbox for full-size media viewing. Renders the media at its natural
 * size within the viewport bounds with a dark backdrop.
 */
export function MediaModal({
  open,
  onOpenChange,
  blobUrl,
  mimeType,
  alt,
}: Readonly<MediaModalProps>): React.JSX.Element | null {
  if (!blobUrl) return null;

  const isImage = mimeType.startsWith('image/');
  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={alt ?? 'Media viewer'}
      className="max-w-[95vw] p-2"
    >
      <div className="flex max-h-[85vh] items-center justify-center overflow-auto">
        {isImage && (
          <Img
            src={blobUrl}
            alt={alt ?? 'Generated media'}
            className="max-h-[85vh] max-w-full object-contain"
          />
        )}
        {isVideo && (
          <video
            src={blobUrl}
            controls
            className="max-h-[85vh] max-w-full"
            aria-label={alt ?? 'Generated video'}
          >
            <track kind="captions" />
          </video>
        )}
        {isAudio && (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- AI-generated audio: no caption track is available; aria-label provides accessible name
          <audio src={blobUrl} controls className="w-full" aria-label={alt ?? 'Generated audio'} />
        )}
      </div>
    </Overlay>
  );
}
