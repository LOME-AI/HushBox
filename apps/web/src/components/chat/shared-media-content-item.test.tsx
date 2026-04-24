import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUseDecryptedSharedMedia = vi.fn<
  (params: { downloadUrl: string | null; contentKey: Uint8Array | null; mimeType: string }) => {
    blobUrl: string | null;
    isLoading: boolean;
    error: Error | null;
  }
>();

vi.mock('@/hooks/use-decrypted-shared-media', () => ({
  useDecryptedSharedMedia: (params: Parameters<typeof mockUseDecryptedSharedMedia>[0]) =>
    mockUseDecryptedSharedMedia(params),
}));

import { SharedMediaContentItem } from './shared-media-content-item';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SharedMediaItemProps extends Omit<
  Parameters<typeof SharedMediaContentItem>[0],
  'contentKey'
> {
  contentKey?: Uint8Array;
}

function defaultItem(
  overrides: Partial<SharedMediaItemProps['item']> = {}
): SharedMediaItemProps['item'] {
  return {
    type: 'media',
    position: 0,
    contentItemId: 'ci-1',
    contentType: 'image',
    mimeType: 'image/png',
    sizeBytes: 2048,
    width: 512,
    height: 512,
    durationMs: null,
    downloadUrl: 'https://signed.example/img?sig=a',
    expiresAt: '2026-04-19T00:05:00.000Z',
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<SharedMediaItemProps> = {}
): Parameters<typeof SharedMediaContentItem>[0] {
  return {
    item: defaultItem(),
    contentKey: new Uint8Array([9, 9, 9]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedMediaContentItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading placeholder while the blob URL resolves', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: true,
      error: null,
    });

    render(<SharedMediaContentItem {...baseProps()} />);

    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows error placeholder when the hook reports an error', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      error: new Error('Decryption failed'),
    });

    render(<SharedMediaContentItem {...baseProps()} />);

    expect(screen.getByRole('status', { name: /failed to load media/i })).toBeInTheDocument();
  });

  it('renders <img> with the blob URL for image content', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:shared-1',
      isLoading: false,
      error: null,
    });

    render(
      <SharedMediaContentItem {...baseProps({ item: defaultItem({ contentType: 'image' }) })} />
    );

    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:shared-1');
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('renders <video> for video content', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:shared-2',
      isLoading: false,
      error: null,
    });

    render(
      <SharedMediaContentItem
        {...baseProps({ item: defaultItem({ contentType: 'video', mimeType: 'video/mp4' }) })}
      />
    );

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:shared-2');
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders <audio> for audio content', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:shared-3',
      isLoading: false,
      error: null,
    });

    render(
      <SharedMediaContentItem
        {...baseProps({ item: defaultItem({ contentType: 'audio', mimeType: 'audio/mpeg' }) })}
      />
    );

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('blob:shared-3');
  });

  it('shows a download link with a friendly filename derived from mime type', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:shared-4',
      isLoading: false,
      error: null,
    });

    render(
      <SharedMediaContentItem
        {...baseProps({ item: defaultItem({ contentType: 'video', mimeType: 'video/mp4' }) })}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-video-\d{8}-\d{6}\.mp4$/);
    expect(link).toHaveAttribute('href', 'blob:shared-4');
  });

  it('opens a lightbox modal when an image is clicked', async () => {
    const user = userEvent.setup();
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:shared-5',
      isLoading: false,
      error: null,
    });

    render(
      <SharedMediaContentItem {...baseProps({ item: defaultItem({ contentType: 'image' }) })} />
    );

    expect(document.querySelectorAll('img')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /open image in lightbox/i }));

    expect(document.querySelectorAll('img').length).toBeGreaterThanOrEqual(2);
  });

  it('does not render lightbox trigger for non-image content', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:shared-6',
      isLoading: false,
      error: null,
    });

    render(
      <SharedMediaContentItem
        {...baseProps({ item: defaultItem({ contentType: 'video', mimeType: 'video/mp4' }) })}
      />
    );

    expect(
      screen.queryByRole('button', { name: /open image in lightbox/i })
    ).not.toBeInTheDocument();
  });

  it('passes downloadUrl, contentKey, and mimeType through to the decrypt hook', () => {
    mockUseDecryptedSharedMedia.mockReturnValue({
      blobUrl: 'blob:x',
      isLoading: false,
      error: null,
    });

    const contentKey = new Uint8Array([1, 2, 3]);
    render(
      <SharedMediaContentItem
        item={defaultItem({
          downloadUrl: 'https://signed.example/y?sig=z',
          mimeType: 'image/webp',
        })}
        contentKey={contentKey}
      />
    );

    expect(mockUseDecryptedSharedMedia).toHaveBeenCalledWith({
      downloadUrl: 'https://signed.example/y?sig=z',
      contentKey,
      mimeType: 'image/webp',
    });
  });
});
