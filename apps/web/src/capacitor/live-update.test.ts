import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks
const {
  mockIsNative,
  mockGetPlatform,
  mockGetApiUrl,
  mockCurrent,
  mockDownload,
  mockSet,
  mockNotifyAppReady,
  mockSetUpgradeRequired,
  mockFetchJson,
  mockClientGetVersion,
} = vi.hoisted(() => ({
  mockIsNative: vi.fn(() => false),
  mockGetPlatform: vi.fn(() => 'web'),
  mockGetApiUrl: vi.fn(() => 'http://localhost:8787'),
  mockCurrent: vi.fn(),
  mockDownload: vi.fn(),
  mockSet: vi.fn(),
  mockNotifyAppReady: vi.fn(),
  mockSetUpgradeRequired: vi.fn(),
  mockFetchJson: vi.fn(),
  mockClientGetVersion: vi.fn(),
}));

vi.mock('./platform.js', () => ({
  isNative: mockIsNative,
  getPlatform: mockGetPlatform,
}));

vi.mock('@/lib/api.js', () => ({
  getApiUrl: mockGetApiUrl,
}));

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: mockCurrent,
    download: mockDownload,
    set: mockSet,
    notifyAppReady: mockNotifyAppReady,
  },
}));

vi.mock('@/stores/app-version.js', () => ({
  useAppVersionStore: {
    getState: () => ({
      setUpgradeRequired: mockSetUpgradeRequired,
    }),
  },
}));

vi.mock('@/lib/api-client.js', () => ({
  fetchJson: mockFetchJson,
  client: {
    api: {
      updates: {
        current: { $get: mockClientGetVersion },
      },
    },
  },
}));

import { checkForUpdate, applyUpdate, getAppVersion, getServerVersion } from './live-update';

describe('live-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAppVersion', () => {
    it('returns "web" when not native', async () => {
      mockIsNative.mockReturnValue(false);

      const version = await getAppVersion();

      expect(version).toBe('web');
      expect(mockCurrent).not.toHaveBeenCalled();
    });

    it('returns bundle version from CapacitorUpdater when native', async () => {
      mockIsNative.mockReturnValue(true);
      mockCurrent.mockResolvedValue({
        bundle: { version: '1.2.3', id: 'abc', downloaded: '', checksum: '', status: 'set' },
        native: '1.0.0',
      });

      const version = await getAppVersion();

      expect(version).toBe('1.2.3');
    });

    it('returns native version when bundle version is builtin or empty', async () => {
      mockIsNative.mockReturnValue(true);
      mockCurrent.mockResolvedValue({
        bundle: { version: 'builtin', id: '', downloaded: '', checksum: '', status: 'success' },
        native: '1.0.0',
      });

      const version = await getAppVersion();

      expect(version).toBe('1.0.0');
    });
  });

  describe('getServerVersion', () => {
    it('returns version from typed client', async () => {
      mockFetchJson.mockResolvedValue({ version: 'abc123' });

      const version = await getServerVersion();

      expect(version).toBe('abc123');
      expect(mockFetchJson).toHaveBeenCalled();
    });

    it('returns null when fetchJson throws', async () => {
      mockFetchJson.mockRejectedValue(new Error('Network error'));

      const version = await getServerVersion();

      expect(version).toBeNull();
    });
  });

  describe('applyUpdate', () => {
    it('does nothing when not native', async () => {
      mockIsNative.mockReturnValue(false);

      await applyUpdate('1.2.3');

      expect(mockDownload).not.toHaveBeenCalled();
    });

    it('downloads bundle with platform-specific URL', async () => {
      mockIsNative.mockReturnValue(true);
      mockGetPlatform.mockReturnValue('ios');
      mockDownload.mockResolvedValue({
        id: 'bundle-id',
        version: '1.2.3',
        downloaded: '',
        checksum: '',
        status: 'set',
      });
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      mockSet.mockResolvedValue(undefined);

      await applyUpdate('1.2.3');

      expect(mockDownload).toHaveBeenCalledWith({
        url: 'http://localhost:8787/api/updates/download/ios/1.2.3',
        version: '1.2.3',
      });
      expect(mockSet).toHaveBeenCalledWith({ id: 'bundle-id' });
    });

    it('uses android-direct platform in download URL', async () => {
      mockIsNative.mockReturnValue(true);
      mockGetPlatform.mockReturnValue('android-direct');
      mockDownload.mockResolvedValue({
        id: 'bundle-id',
        version: '2.0.0',
        downloaded: '',
        checksum: '',
        status: 'set',
      });
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      mockSet.mockResolvedValue(undefined);

      await applyUpdate('2.0.0');

      expect(mockDownload).toHaveBeenCalledWith({
        url: 'http://localhost:8787/api/updates/download/android-direct/2.0.0',
        version: '2.0.0',
      });
    });

    it('sets upgradeRequired on download failure', async () => {
      mockIsNative.mockReturnValue(true);
      mockDownload.mockRejectedValue(new Error('Download failed'));

      await applyUpdate('1.2.3');

      expect(mockSetUpgradeRequired).toHaveBeenCalledWith(true);
      expect(mockSet).not.toHaveBeenCalled();
    });
  });

  describe('checkForUpdate', () => {
    it('does nothing when not native', async () => {
      mockIsNative.mockReturnValue(false);

      const result = await checkForUpdate();

      expect(result).toEqual({ updateAvailable: false });
      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('notifies app ready and returns no update when versions match', async () => {
      mockIsNative.mockReturnValue(true);
      mockCurrent.mockResolvedValue({
        bundle: { version: 'abc123', id: 'some-id', downloaded: '', checksum: '', status: 'set' },
        native: '1.0.0',
      });
      mockFetchJson.mockResolvedValue({ version: 'abc123' });

      const result = await checkForUpdate();

      expect(result).toEqual({ updateAvailable: false });
      expect(mockNotifyAppReady).toHaveBeenCalled();
    });

    it('notifies app ready and returns update info when versions differ', async () => {
      mockIsNative.mockReturnValue(true);
      mockCurrent.mockResolvedValue({
        bundle: {
          version: 'old-version',
          id: 'some-id',
          downloaded: '',
          checksum: '',
          status: 'set',
        },
        native: '1.0.0',
      });
      mockFetchJson.mockResolvedValue({ version: 'new-version' });

      const result = await checkForUpdate();

      expect(result).toEqual({
        updateAvailable: true,
        serverVersion: 'new-version',
      });
      expect(mockNotifyAppReady).toHaveBeenCalled();
    });

    it('skips version check when server version is dev-local', async () => {
      mockIsNative.mockReturnValue(true);
      mockCurrent.mockResolvedValue({
        bundle: { version: '1.0.0', id: 'some-id', downloaded: '', checksum: '', status: 'set' },
        native: '1.0.0',
      });
      mockFetchJson.mockResolvedValue({ version: 'dev-local' });

      const result = await checkForUpdate();

      expect(result).toEqual({ updateAvailable: false });
    });

    it('returns no update when server version fetch fails', async () => {
      mockIsNative.mockReturnValue(true);
      mockCurrent.mockResolvedValue({
        bundle: { version: '1.0.0', id: 'some-id', downloaded: '', checksum: '', status: 'set' },
        native: '1.0.0',
      });
      mockFetchJson.mockRejectedValue(new Error('fetch failed'));

      const result = await checkForUpdate();

      expect(result).toEqual({ updateAvailable: false });
      expect(mockNotifyAppReady).toHaveBeenCalled();
    });
  });
});
