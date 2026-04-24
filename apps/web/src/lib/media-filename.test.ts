import { describe, it, expect, vi, afterEach } from 'vitest';
import { getExtensionFromMime, buildDownloadFilename } from './media-filename';

describe('getExtensionFromMime', () => {
  it('maps image/png to png', () => {
    expect(getExtensionFromMime('image/png')).toBe('png');
  });

  it('maps image/jpeg to jpg', () => {
    expect(getExtensionFromMime('image/jpeg')).toBe('jpg');
  });

  it('maps image/jpg to jpg (non-standard but common)', () => {
    expect(getExtensionFromMime('image/jpg')).toBe('jpg');
  });

  it('maps image/webp to webp', () => {
    expect(getExtensionFromMime('image/webp')).toBe('webp');
  });

  it('maps video/mp4 to mp4', () => {
    expect(getExtensionFromMime('video/mp4')).toBe('mp4');
  });

  it('maps audio/mpeg to mp3', () => {
    expect(getExtensionFromMime('audio/mpeg')).toBe('mp3');
  });

  it('maps audio/mp3 to mp3', () => {
    expect(getExtensionFromMime('audio/mp3')).toBe('mp3');
  });

  it('maps audio/wav to wav', () => {
    expect(getExtensionFromMime('audio/wav')).toBe('wav');
  });

  it('falls back to bin for unknown MIME types', () => {
    expect(getExtensionFromMime('application/unknown')).toBe('bin');
    expect(getExtensionFromMime('audio/ogg')).toBe('bin');
    expect(getExtensionFromMime('image/heic')).toBe('bin');
  });
});

describe('buildDownloadFilename', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a filename with the content type, stamp, and extension', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 17, 10, 30, 45));

    expect(buildDownloadFilename('image', 'image/png')).toBe('hushbox-image-20260417-103045.png');
  });

  it('zero-pads single-digit month, day, hour, minute, and second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 3, 4, 5, 6));

    expect(buildDownloadFilename('video', 'video/mp4')).toBe('hushbox-video-20260103-040506.mp4');
  });

  it('uses the bin fallback extension for unknown mime types', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 17, 10, 30, 45));

    expect(buildDownloadFilename('audio', 'audio/ogg')).toBe('hushbox-audio-20260417-103045.bin');
  });
});
