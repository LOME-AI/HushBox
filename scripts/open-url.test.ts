import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('open', () => ({ default: vi.fn() }));

import open from 'open';
import { buildUrl, openUrl } from './open-url.js';

const mockOpen = vi.mocked(open);

describe('open-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['OU_TEST_PORT'];
  });

  describe('buildUrl', () => {
    it('concatenates prefix and env var value', () => {
      process.env['OU_TEST_PORT'] = '4321';
      expect(buildUrl('http://localhost:', 'OU_TEST_PORT')).toBe('http://localhost:4321');
    });

    it('throws when the env var is unset', () => {
      expect(() => buildUrl('http://localhost:', 'OU_TEST_MISSING')).toThrow(
        'open-url: env var OU_TEST_MISSING is not set'
      );
    });

    it('throws when the env var is empty', () => {
      process.env['OU_TEST_PORT'] = '';
      expect(() => buildUrl('http://localhost:', 'OU_TEST_PORT')).toThrow(
        'open-url: env var OU_TEST_PORT is not set'
      );
    });

    it('preserves additional path segments in the prefix', () => {
      process.env['OU_TEST_PORT'] = '4321';
      expect(buildUrl('http://localhost:', 'OU_TEST_PORT')).toBe('http://localhost:4321');
    });
  });

  describe('openUrl', () => {
    it('opens the URL built from prefix and env var', async () => {
      process.env['OU_TEST_PORT'] = '4321';
      mockOpen.mockResolvedValue(undefined as never);
      await openUrl('http://localhost:', 'OU_TEST_PORT');
      expect(mockOpen).toHaveBeenCalledWith('http://localhost:4321');
    });

    it('throws on missing env var without calling open', async () => {
      await expect(openUrl('http://localhost:', 'OU_TEST_MISSING')).rejects.toThrow(
        'OU_TEST_MISSING is not set'
      );
      expect(mockOpen).not.toHaveBeenCalled();
    });
  });
});
