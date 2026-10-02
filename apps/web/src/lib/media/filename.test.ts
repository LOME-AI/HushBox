import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_LOCAL_DAY_START,
  TEST_LOCAL_MONTH_START,
  freezeClock,
} from '@hushbox/shared/test-time';
import { getExtensionFromMime, buildDownloadFilename } from './filename';

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

  it('maps video/webm to webm', () => {
    expect(getExtensionFromMime('video/webm')).toBe('webm');
  });

  it('maps video/mpeg to mpeg (not the mp3 audio extension)', () => {
    expect(getExtensionFromMime('video/mpeg')).toBe('mpeg');
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
    freezeClock(TEST_LOCAL_DAY_START + 10 * HOUR_MS + 30 * MINUTE_MS + 45 * SECOND_MS);

    expect(buildDownloadFilename('image', 'image/png')).toBe('hushbox-image-20260115-103045.png');
  });

  it('zero-pads single-digit month, day, hour, minute, and second', () => {
    freezeClock(TEST_LOCAL_MONTH_START + 4 * HOUR_MS + 5 * MINUTE_MS + 6 * SECOND_MS);

    expect(buildDownloadFilename('video', 'video/mp4')).toBe('hushbox-video-20260101-040506.mp4');
  });

  it('uses the bin fallback extension for unknown mime types', () => {
    freezeClock(TEST_LOCAL_DAY_START + 10 * HOUR_MS + 30 * MINUTE_MS + 45 * SECOND_MS);

    expect(buildDownloadFilename('audio', 'audio/ogg')).toBe('hushbox-audio-20260115-103045.bin');
  });
});
