/**
 * Deterministic media fixtures for the dev media-conversation seed.
 *
 * The video is the same canned clip the mock provider emits, so a seeded turn
 * is byte-identical to a generated one and both decode in a browser. The image
 * is a valid 1×1 PNG; the seed path, storage layout and crypto are identical
 * either way.
 */

import {
  MOCK_VIDEO_BYTES,
  MOCK_VIDEO_DURATION_MS,
  MOCK_VIDEO_HEIGHT,
  MOCK_VIDEO_MIME_TYPE,
  MOCK_VIDEO_WIDTH,
} from '../slices/models/adapters/mock-video-clip.js';

const TEST_IMAGE_PNG_BASE64 =
  // eslint-disable-next-line no-secrets/no-secrets -- a committed 1×1 PNG fixture (public bytes), not a credential
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  // Every index below length yields a code point; Number() keeps the type
  // narrow without an uncoverable `?? 0` arm.
  return Uint8Array.from(binary, (char) => Number(char.codePointAt(0)));
}

interface DevMediaFixture {
  readonly contentType: 'image' | 'video';
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | undefined;
}

export const DEV_MEDIA_FIXTURES: Readonly<Record<'image' | 'video', DevMediaFixture>> = {
  image: {
    contentType: 'image',
    bytes: decodeBase64(TEST_IMAGE_PNG_BASE64),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    durationMs: undefined,
  },
  video: {
    contentType: 'video',
    bytes: MOCK_VIDEO_BYTES,
    mimeType: MOCK_VIDEO_MIME_TYPE,
    width: MOCK_VIDEO_WIDTH,
    height: MOCK_VIDEO_HEIGHT,
    durationMs: MOCK_VIDEO_DURATION_MS,
  },
};
