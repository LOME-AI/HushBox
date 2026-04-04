import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppVersionStore } from '@/stores/app-version';

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: {
    hide: vi.fn(),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('useSplashScreen', () => {
  beforeEach(() => {
    useAppVersionStore.setState({ upgradeRequired: false, updateInProgress: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not call hide on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(true);
    });

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('does not hide splash when app is not stable', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(false);
    });

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('hides splash when app becomes stable on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(true);
    });

    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
  });

  it('hides splash when upgradeRequired is true even if app is not stable', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    useAppVersionStore.setState({ upgradeRequired: true });

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(false);
    });

    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
  });

  it('does not hide splash when updateInProgress is true even if app is stable', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    useAppVersionStore.setState({ updateInProgress: true });

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(true);
    });

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('does not hide when both app is not stable and upgradeRequired is false', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    useAppVersionStore.setState({ upgradeRequired: false });

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(false);
    });

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });
});
