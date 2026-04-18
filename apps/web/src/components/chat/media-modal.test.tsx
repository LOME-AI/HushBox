import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaModal } from './media-modal';

describe('MediaModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    blobUrl: 'blob:mock-url',
    mimeType: 'image/png',
    alt: 'Test media',
  };

  it('renders img when mimeType starts with image/ and blobUrl is non-null', () => {
    render(<MediaModal {...defaultProps} mimeType="image/jpeg" />);

    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:mock-url');
  });

  it('renders video when mimeType starts with video/', () => {
    render(<MediaModal {...defaultProps} mimeType="video/mp4" />);

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:mock-url');
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders audio when mimeType starts with audio/', () => {
    render(<MediaModal {...defaultProps} mimeType="audio/mpeg" />);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('blob:mock-url');
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('returns empty (no img/video/audio) when blobUrl is null', () => {
    render(<MediaModal {...defaultProps} blobUrl={null} />);

    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('calls onOpenChange when closed via close button', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<MediaModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses provided alt text for the image', () => {
    render(<MediaModal {...defaultProps} mimeType="image/png" alt="My custom alt text" />);

    const img = document.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('My custom alt text');
  });

  it('falls back to default alt text when alt is not provided', () => {
    render(
      <MediaModal
        open={defaultProps.open}
        onOpenChange={defaultProps.onOpenChange}
        blobUrl={defaultProps.blobUrl}
        mimeType="image/png"
      />
    );

    const img = document.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('Generated media');
  });

  it('does not render image element for audio/video mimeTypes', () => {
    const { rerender } = render(<MediaModal {...defaultProps} mimeType="video/mp4" />);
    expect(document.querySelector('img')).toBeNull();

    rerender(<MediaModal {...defaultProps} mimeType="audio/mpeg" />);
    expect(document.querySelector('img')).toBeNull();
  });
});
