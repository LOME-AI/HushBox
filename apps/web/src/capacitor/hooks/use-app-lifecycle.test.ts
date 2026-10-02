import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type StateChangeCallback = (state: { isActive: boolean }) => void;
let capturedCallback: StateChangeCallback | null = null;

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, callback: StateChangeCallback) => {
      if (event === 'appStateChange') {
        capturedCallback = callback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('useAppLifecycle', () => {
  beforeEach(() => {
    capturedCallback = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not register listener on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { App } = await import('@capacitor/app');
    const { useAppLifecycle } = await import('./use-app-lifecycle.js');

    renderHook(() => {
      useAppLifecycle();
    });

    expect(App.addListener).not.toHaveBeenCalled();
  });

  it('registers appStateChange listener on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { App } = await import('@capacitor/app');
    const { useAppLifecycle } = await import('./use-app-lifecycle.js');

    renderHook(() => {
      useAppLifecycle();
    });

    expect(App.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function));
  });

  it('calls onResume when app becomes active', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onResume = vi.fn();
    const { useAppLifecycle } = await import('./use-app-lifecycle.js');

    renderHook(() => {
      useAppLifecycle({ onResume });
    });

    expect(capturedCallback).not.toBeNull();
    capturedCallback!({ isActive: true });

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('calls onPause when app goes to background', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onPause = vi.fn();
    const { useAppLifecycle } = await import('./use-app-lifecycle.js');

    renderHook(() => {
      useAppLifecycle({ onPause });
    });

    expect(capturedCallback).not.toBeNull();
    capturedCallback!({ isActive: false });

    expect(onPause).toHaveBeenCalledTimes(1);
  });
});
