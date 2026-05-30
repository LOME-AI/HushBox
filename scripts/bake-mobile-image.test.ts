import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./lib/mobile-image.js', () => ({
  bakeImage: vi.fn().mockResolvedValue('ghcr.io/lome-ai/hushbox-android-emulator:abc'),
}));

import { bakeImage } from './lib/mobile-image.js';
import { parseArgs, main } from './bake-mobile-image.js';

const mockBakeImage = vi.mocked(bakeImage);

describe('bake-mobile-image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBakeImage.mockResolvedValue('ghcr.io/lome-ai/hushbox-android-emulator:abc');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('defaults push to false (safe for local invocation)', () => {
      expect(parseArgs([])).toEqual({ push: false });
    });

    it('returns push true when --push is present', () => {
      expect(parseArgs(['--push'])).toEqual({ push: true });
    });

    it('returns push false when --no-push is present', () => {
      expect(parseArgs(['--no-push'])).toEqual({ push: false });
    });

    it('--no-push takes precedence over --push when both are passed', () => {
      // Explicit safety: if a caller accidentally includes both, the safer
      // option wins. Avoids surprise pushes in CLI composition.
      expect(parseArgs(['--push', '--no-push'])).toEqual({ push: false });
    });

    it('ignores unrelated flags', () => {
      expect(parseArgs(['--verbose', '--push'])).toEqual({ push: true });
    });
  });

  describe('main', () => {
    it('calls bakeImage with push=false by default', async () => {
      await main([]);
      expect(mockBakeImage).toHaveBeenCalledWith({ push: false });
    });

    it('calls bakeImage with push=true when --push is supplied', async () => {
      await main(['--push']);
      expect(mockBakeImage).toHaveBeenCalledWith({ push: true });
    });
  });
});
