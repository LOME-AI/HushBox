import { describe, it, expect } from 'vitest';
import { IMAGE_MIME_TYPES } from './media-mime.ts';

describe('IMAGE_MIME_TYPES', () => {
  it('is the accepted image mime allowlist for media I/O', () => {
    expect(IMAGE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});
