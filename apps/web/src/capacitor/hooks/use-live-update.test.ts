import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

interface LifecycleCallbacks {
  onResume?: () => void;
  onPause?: () => void;
}

const { mockCheckForUpdate, mockApplyUpdate, mockIsNative } = vi.hoisted(() => ({
  mockCheckForUpdate: vi.fn(),
  mockApplyUpdate: vi.fn(),
  mockIsNative: vi.fn(() => false),
}));

vi.mock('../live-update.js', () => ({
  checkForUpdate: mockCheckForUpdate,
  applyUpdate: mockApplyUpdate,
}));

vi.mock('../platform.js', () => ({
  isNative: mockIsNative,
}));

let capturedCallbacks: LifecycleCallbacks | undefined;
vi.mock('./use-app-lifecycle.js', () => ({
  useAppLifecycle: vi.fn((callbacks?: LifecycleCallbacks) => {
    capturedCallbacks = callbacks;
  }),
}));

import { useAppVersionStore } from '@/stores/app-version';
import { useLiveUpdate } from './use-live-update';

describe('useLiveUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = undefined;
    useAppVersionStore.setState({ upgradeRequired: false, otaInProgress: false });
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    mockApplyUpdate.mockResolvedValue(undefined);
  });

  it('does not check for updates on web', () => {
    mockIsNative.mockReturnValue(false);

    renderHook(() => {
      useLiveUpdate();
    });

    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it('checks for updates on mount when native', async () => {
    mockIsNative.mockReturnValue(true);

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
  });

  it('applies update on mount when update is available', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockApplyUpdate).toHaveBeenCalledWith('v2');
    });
  });

  it('does not apply update on mount when no update available', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('marks otaInProgress while checking and clears it when no update is available', async () => {
    mockIsNative.mockReturnValue(true);
    let resolveCheck!: (value: { updateAvailable: boolean }) => void;
    mockCheckForUpdate.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      })
    );

    renderHook(() => {
      useLiveUpdate();
    });

    // True while the check is in flight — this is what suppresses the
    // upgrade-required modal during the version-mismatch window.
    await vi.waitFor(() => {
      expect(useAppVersionStore.getState().otaInProgress).toBe(true);
    });

    resolveCheck({ updateAvailable: false });

    await vi.waitFor(() => {
      expect(useAppVersionStore.getState().otaInProgress).toBe(false);
    });
  });

  it('keeps otaInProgress set through apply, then clears it (failed-apply fallback)', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });
    let resolveApply!: () => void;
    mockApplyUpdate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveApply = resolve;
      })
    );

    renderHook(() => {
      useLiveUpdate();
    });

    // Stays true across the download/apply window.
    await vi.waitFor(() => {
      expect(mockApplyUpdate).toHaveBeenCalledWith('v2');
    });
    expect(useAppVersionStore.getState().otaInProgress).toBe(true);

    // A failed apply resolves without reloading the JS context — the flag must
    // clear so the upgrade-required modal can surface as the fallback.
    resolveApply();

    await vi.waitFor(() => {
      expect(useAppVersionStore.getState().otaInProgress).toBe(false);
    });
  });

  it('registers app lifecycle listener with onResume', async () => {
    const { useAppLifecycle } = vi.mocked(await import('./use-app-lifecycle.js'));

    renderHook(() => {
      useLiveUpdate();
    });

    expect(useAppLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ onResume: expect.any(Function) })
    );
  });

  it('checks for update on resume', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    mockCheckForUpdate.mockClear();

    capturedCallbacks?.onResume?.();

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
  });

  it('applies update on resume when available', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    mockCheckForUpdate.mockClear();
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v3' });

    capturedCallbacks?.onResume?.();

    await vi.waitFor(() => {
      expect(mockApplyUpdate).toHaveBeenCalledWith('v3');
    });
  });
});
