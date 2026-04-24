import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./media-modal', () => ({
  MediaModal: ({ open, alt }: { open: boolean; alt: string }) =>
    open ? <div data-testid="media-modal" data-alt={alt} /> : null,
}));

import { MediaPlaceholder, MediaPreview } from './media-preview';

function baseProps(
  overrides: Partial<Parameters<typeof MediaPreview>[0]> = {}
): Parameters<typeof MediaPreview>[0] {
  return {
    blobUrl: 'blob:preview-1',
    mimeType: 'image/png',
    contentType: 'image',
    ariaPrefix: 'Generated',
    ...overrides,
  };
}

describe('MediaPlaceholder', () => {
  it('renders the loading label when status is loading', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" />);
    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
  });

  it('renders the error label when status is error', () => {
    render(<MediaPlaceholder width={null} height={null} status="error" />);
    expect(screen.getByRole('status', { name: /failed to load media/i })).toBeInTheDocument();
  });

  it('uses the given dimensions as the aspect ratio', () => {
    render(<MediaPlaceholder width={1024} height={512} status="loading" />);
    const placeholder = screen.getByRole('status');
    expect(placeholder.style.aspectRatio).toBe('1024 / 512');
  });

  it('falls back to 1 / 1 aspect ratio when dimensions are missing', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" />);
    const placeholder = screen.getByRole('status');
    expect(placeholder.style.aspectRatio).toBe('1 / 1');
  });
});

describe('MediaPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders <img> for image content with the ariaPrefix in the alt text', () => {
    render(<MediaPreview {...baseProps({ contentType: 'image', ariaPrefix: 'Generated' })} />);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('Generated media');
    expect(img?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('uses "Shared media" when ariaPrefix is "Shared"', () => {
    render(<MediaPreview {...baseProps({ ariaPrefix: 'Shared' })} />);
    expect(document.querySelector('img')?.getAttribute('alt')).toBe('Shared media');
  });

  it('renders <video> for video content with ariaPrefix in the aria-label', () => {
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'video',
          mimeType: 'video/mp4',
          ariaPrefix: 'Shared',
        })}
      />
    );
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('aria-label')).toBe('Shared video');
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders <audio> for audio content with ariaPrefix in the aria-label', () => {
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'audio',
          mimeType: 'audio/mpeg',
          ariaPrefix: 'Generated',
        })}
      />
    );
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('aria-label')).toBe('Generated audio');
  });

  it('shows a download link with a filename derived from the mime type', () => {
    render(<MediaPreview {...baseProps({ contentType: 'video', mimeType: 'video/mp4' })} />);
    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-video-\d{8}-\d{6}\.mp4$/);
    expect(link).toHaveAttribute('href', 'blob:preview-1');
  });

  it('opens the lightbox modal when an image is clicked', async () => {
    const user = userEvent.setup();
    render(<MediaPreview {...baseProps({ ariaPrefix: 'Shared' })} />);

    expect(screen.queryByTestId('media-modal')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /open image in lightbox/i }));
    const modal = screen.getByTestId('media-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.dataset['alt']).toBe('Shared media');
  });

  it('does not render the lightbox trigger for non-image content', () => {
    render(<MediaPreview {...baseProps({ contentType: 'video', mimeType: 'video/mp4' })} />);
    expect(
      screen.queryByRole('button', { name: /open image in lightbox/i })
    ).not.toBeInTheDocument();
  });
});
