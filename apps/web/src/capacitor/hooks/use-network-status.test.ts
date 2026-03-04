import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type StatusChangeCallback = (status: { connected: boolean; connectionType: string }) => void;
let capturedCallback: StatusChangeCallback | null = null;

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(() => Promise.resolve({ connected: true, connectionType: 'wifi' })),
    addListener: vi.fn((event: string, callback: StatusChangeCallback) => {
      if (event === 'networkStatusChange') {
        capturedCallback = callback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('useNetworkStatus', () => {
  beforeEach(() => {
    capturedCallback = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not register listener on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { Network } = await import('@capacitor/network');
    const { useNetworkStatus } = await import('./use-network-status.js');

    renderHook(() => {
      useNetworkStatus();
    });

    expect(Network.addListener).not.toHaveBeenCalled();
  });

  it('returns online by default', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { useNetworkStatus } = await import('./use-network-status.js');

    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.isOffline).toBe(false);
  });

  it('checks initial status and registers listener on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { Network } = await import('@capacitor/network');
    const { useNetworkStatus } = await import('./use-network-status.js');

    renderHook(() => {
      useNetworkStatus();
    });

    expect(Network.getStatus).toHaveBeenCalled();
    expect(Network.addListener).toHaveBeenCalledWith('networkStatusChange', expect.any(Function));
  });

  it('updates isOffline when network status changes', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { useNetworkStatus } = await import('./use-network-status.js');

    const { result } = renderHook(() => useNetworkStatus());

    expect(capturedCallback).not.toBeNull();
    act(() => {
      capturedCallback!({ connected: false, connectionType: 'none' });
    });

    expect(result.current.isOffline).toBe(true);
  });

  it('returns online when network reconnects', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { useNetworkStatus } = await import('./use-network-status.js');

    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      capturedCallback!({ connected: false, connectionType: 'none' });
    });
    expect(result.current.isOffline).toBe(true);

    act(() => {
      capturedCallback!({ connected: true, connectionType: 'wifi' });
    });
    expect(result.current.isOffline).toBe(false);
  });
});
