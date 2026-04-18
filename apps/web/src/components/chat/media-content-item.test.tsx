import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MessageMediaItem } from '@/lib/api';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseDecryptedMedia = vi.fn<
  (params: {
    contentItemId: string;
    conversationId: string;
    epochNumber: number;
    wrappedContentKey: string;
    mimeType: string;
  }) => {
    blobUrl: string | null;
    isLoading: boolean;
    error: Error | null;
  }
>();

vi.mock('@/hooks/use-decrypted-media', () => ({
  useDecryptedMedia: (params: Parameters<typeof mockUseDecryptedMedia>[0]) =>
    mockUseDecryptedMedia(params),
}));

import { MediaContentItem } from './media-content-item';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultItem(overrides: Partial<MessageMediaItem> = {}): MessageMediaItem {
  return {
    id: 'media-1',
    contentType: 'image',
    position: 0,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 512,
    height: 512,
    ...overrides,
  };
}

const baseProps = {
  conversationId: 'conv-1',
  epochNumber: 1,
  wrappedContentKey: 'wrapped-b64',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaContentItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading placeholder when isLoading is true', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: true,
      error: null,
    });

    render(<MediaContentItem item={defaultItem()} {...baseProps} />);

    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows loading placeholder when blobUrl is null and not errored', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      error: null,
    });

    render(<MediaContentItem item={defaultItem()} {...baseProps} />);

    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
  });

  it('shows error placeholder when useDecryptedMedia returns error', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      error: new Error('Decryption failed'),
    });

    render(<MediaContentItem item={defaultItem()} {...baseProps} />);

    expect(screen.getByRole('status', { name: /failed to load media/i })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders <img> with the blob URL when contentType is image and success', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(<MediaContentItem item={defaultItem({ contentType: 'image' })} {...baseProps} />);

    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:mock-1');
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('renders <video> when contentType is video', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentType: 'video', mimeType: 'video/mp4' })}
        {...baseProps}
      />
    );

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:mock-1');
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders <audio> when contentType is audio', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentType: 'audio', mimeType: 'audio/mpeg' })}
        {...baseProps}
      />
    );

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('blob:mock-1');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('shows download button with the correct filename for png', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ id: 'abc-123', mimeType: 'image/png' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-image-\d{8}-\d{6}\.png$/);
    expect(link).toHaveAttribute('href', 'blob:mock-1');
  });

  it('derives filename extension from mp4 mime type for videos', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ id: 'vid-9', contentType: 'video', mimeType: 'video/mp4' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-video-\d{8}-\d{6}\.mp4$/);
  });

  it('derives filename extension from audio mime type', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ id: 'aud-7', contentType: 'audio', mimeType: 'audio/mpeg' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-audio-\d{8}-\d{6}\.mp3$/);
  });

  it('falls back to bin extension for unknown mime types', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ id: 'weird-1', mimeType: 'application/octet-stream' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-image-\d{8}-\d{6}\.bin$/);
  });

  it('clicking the image opens the MediaModal lightbox', async () => {
    const user = userEvent.setup();
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(<MediaContentItem item={defaultItem({ contentType: 'image' })} {...baseProps} />);

    // Before clicking, only the inline image should be present (no modal content).
    expect(document.querySelectorAll('img')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /open image in lightbox/i }));

    // The modal renders a second img with the blob URL at larger size.
    expect(document.querySelectorAll('img').length).toBeGreaterThanOrEqual(2);
  });

  it('does not render click-to-open button for non-image content', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentType: 'video', mimeType: 'video/mp4' })}
        {...baseProps}
      />
    );

    expect(
      screen.queryByRole('button', { name: /open image in lightbox/i })
    ).not.toBeInTheDocument();
  });

  it('passes correct parameters to useDecryptedMedia', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ id: 'item-42', mimeType: 'image/webp' })}
        conversationId="conv-xyz"
        epochNumber={5}
        wrappedContentKey="key-b64-abc"
      />
    );

    expect(mockUseDecryptedMedia).toHaveBeenCalledWith({
      contentItemId: 'item-42',
      conversationId: 'conv-xyz',
      epochNumber: 5,
      wrappedContentKey: 'key-b64-abc',
      mimeType: 'image/webp',
    });
  });
});
